/*!
 * platforms/tizenbrew/proxy-service.js — Twellie HLS relay for TizenBrew.
 *
 * TizenBrew runs this file as a module serviceFile: it fetches the raw
 * script from jsDelivr and executes it in the TizenBrew Node service, so
 * this file must stay a single self-contained classic script. It uses only
 * Node core modules available through the sandbox require.
 *
 * Why it exists: the TizenBrew page runs at http://127.0.0.1:8081. Twitch's
 * playlist CDN returns 403 when a browser fetch carries that Origin, while
 * returning 200 when no Origin is sent. This relay listens only on the TV's
 * loopback interface, fetches playlists and segments with Node http/https
 * (which sends no browser Origin), adds permissive CORS for the local page,
 * and rewrites playlist URLs so the whole HLS chain stays on loopback.
 *
 * It also implements the playback-session technique popularised by
 * TTV LOL PRO v2 (GPL-3.0), rewritten for this relay: route Usher and the
 * first media-playlist request through an HTTP proxy, detect Twitch's
 * server-side ad stitching in media playlists, then obtain an anonymous
 * replacement playback token/manifest through the opposite route and map
 * each quality to the replacement assigned stream. Segments stay direct.
 */
'use strict';

var http = require('http');
var https = require('https');
var tls = require('tls');
var nodeUrl = require('url');
var URLCtor = nodeUrl.URL;

var PROXY_PORT = 47994;
var PROXY_HOST = '127.0.0.1';
var MAX_REDIRECTS = 5;
var MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
var UPSTREAM_TIMEOUT_MS = 20000;
var ALLOWED_HOSTS = [
  'ttvnw.net',
  'twitch.tv',
  'jtvnw.net',
  'twitchcdn.net',
  'live-video.net',
  'cloudfront.net',
  'akamaized.net'
];
var upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
var activeServer = null;

var TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
var MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
var SESSION_TTL_MS = 30 * 60 * 1000;
var MAX_AD_SESSIONS = 12;

var DEFAULT_AD_CONFIG = {
  enabled: true,
  anonymousMode: true,
  // The public optimized endpoints published for TTV LOL PRO. Only token,
  // Usher and first-playlist signalling use them; media segments stay direct.
  proxies: [
    'http://chromium.api.cdn-perfprod.com:2023',
    'http://firefox.api.cdn-perfprod.com:2023'
  ],
  maxAttempts: 3,
  cooldownResponses: 15,
  requestTimeoutMs: 12000
};
var adConfig = cloneAdConfig(DEFAULT_AD_CONFIG);
var adSessions = {};
var adSessionOrder = [];
var variantOwners = {};
var variantProxyCounts = {};
var nextSessionId = 1;

function cloneAdConfig(source) {
  var out = {};
  var key;
  source = source || {};
  for (key in DEFAULT_AD_CONFIG) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_AD_CONFIG, key)) {
      out[key] = DEFAULT_AD_CONFIG[key];
    }
  }
  for (key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) { out[key] = source[key]; }
  }
  out.proxies = (source.proxies || DEFAULT_AD_CONFIG.proxies || []).slice();
  out.maxAttempts = Math.max(1, Number(out.maxAttempts) || DEFAULT_AD_CONFIG.maxAttempts);
  out.cooldownResponses = Math.max(0, Number(out.cooldownResponses) || 0);
  out.requestTimeoutMs = Math.max(1000, Number(out.requestTimeoutMs) || DEFAULT_AD_CONFIG.requestTimeoutMs);
  return out;
}

function configureAdAvoidance(options) {
  adConfig = cloneAdConfig(options || DEFAULT_AD_CONFIG);
  return adConfig;
}

function directRoute() {
  return { kind: 'direct', id: 'direct', proxy: null };
}

function parseProxyUrl(value) {
  var raw = String(value || '').trim();
  var parsed;
  if (!raw) { return null; }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) { raw = 'http://' + raw; }
  try { parsed = new URLCtor(raw); } catch (e) { return null; }
  if (parsed.protocol !== 'http:' || !parsed.hostname) { return null; }
  var auth = '';
  if (parsed.username) {
    auth = decodeURIComponent(parsed.username);
    if (parsed.password) { auth += ':' + decodeURIComponent(parsed.password); }
  }
  return {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port: Number(parsed.port) || 80,
    auth: auth,
    label: parsed.hostname + ':' + (Number(parsed.port) || 80)
  };
}

function configuredProxyRoutes() {
  var routes = [];
  var i;
  var proxy;
  for (i = 0; i < adConfig.proxies.length; i++) {
    proxy = parseProxyUrl(adConfig.proxies[i]);
    if (proxy) { routes.push({ kind: 'proxy', id: 'proxy-' + i, proxy: proxy }); }
  }
  return routes;
}

function routeId(route) {
  return route && route.id ? route.id : 'direct';
}

function sameRoute(a, b) {
  return routeId(a) === routeId(b);
}

function generateRandomString(length, lowercaseOnly) {
  var charset = lowercaseOnly
    ? 'abcdefghijklmnopqrstuvwxyz0123456789'
    : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var out = '';
  var i;
  for (i = 0; i < length; i++) {
    out += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return out;
}

function hostAllowed(hostname) {
  var host = String(hostname || '').toLowerCase();
  var i;
  var domain;
  for (i = 0; i < ALLOWED_HOSTS.length; i++) {
    domain = ALLOWED_HOSTS[i];
    if (host === domain || host.slice(-(domain.length + 1)) === '.' + domain) {
      return true;
    }
  }
  return false;
}

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': (req && req.headers && req.headers['access-control-request-headers']) || '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
  };
}

function sendText(req, res, status, text, contentType) {
  if (res.headersSent) { return; }
  var body = Buffer.from(String(text || ''), 'utf8');
  var headers = corsHeaders(req);
  headers['Content-Type'] = contentType || 'text/plain; charset=utf-8';
  headers['Content-Length'] = body.length;
  headers['Cache-Control'] = 'no-store';
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); }
  else { res.end(body); }
}

function proxyUrlFor(req, absoluteUrl) {
  var host = (req.headers && req.headers.host) || (PROXY_HOST + ':' + PROXY_PORT);
  return 'http://' + host + '/proxy?url=' + encodeURIComponent(absoluteUrl);
}

function rewriteUri(uri, req, baseUrl) {
  var absolute;
  try {
    absolute = new URLCtor(uri, baseUrl);
  } catch (e) {
    return uri;
  }
  if (absolute.protocol !== 'https:' || !hostAllowed(absolute.hostname)) {
    return uri;
  }
  return proxyUrlFor(req, absolute.href);
}

function rewriteM3u8(text, req, baseUrl) {
  var lines = String(text || '').split('\n');
  var out = [];
  var i;
  var line;
  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (line.charAt(line.length - 1) === '\r') { line = line.slice(0, -1); }
    if (line && line.charAt(0) !== '#') {
      out.push(rewriteUri(line, req, baseUrl));
    } else {
      out.push(line.replace(/URI=("([^"]+)"|([^,]+))/g, function (match, raw, quoted, bare) {
        var uri = quoted || bare;
        var rewritten = rewriteUri(uri, req, baseUrl);
        return quoted ? 'URI="' + rewritten + '"' : 'URI=' + rewritten;
      }));
    }
  }
  return out.join('\n');
}

function isPlaylist(target, headers) {
  var type = String((headers && headers['content-type']) || '').toLowerCase();
  var pathname = '';
  try { pathname = new URLCtor(target).pathname.toLowerCase(); } catch (e) {}
  return pathname.slice(-5) === '.m3u8' ||
    type.indexOf('mpegurl') >= 0 || type.indexOf('x-mpegurl') >= 0;
}

function responseHeaders(req, upstreamHeaders) {
  var headers = corsHeaders(req);
  var names = [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'cache-control', 'etag', 'last-modified', 'expires'
  ];
  var i;
  var name;
  var title;
  for (i = 0; i < names.length; i++) {
    name = names[i];
    if (upstreamHeaders && upstreamHeaders[name]) {
      title = name.replace(/(^|-)([a-z])/g, function (match, dash, chr) {
        return (dash || '') + chr.toUpperCase();
      });
      headers[title] = upstreamHeaders[name];
    }
  }
  return headers;
}

function createProxyAgent(proxy, targetHost, targetPort, timeoutMs) {
  var agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = function (options, callback) {
    var headers = {
      Host: targetHost + ':' + targetPort,
      'Proxy-Connection': 'keep-alive'
    };
    var done = false;
    function finish(err, socket) {
      if (done) { return; }
      done = true;
      callback(err, socket);
    }
    if (proxy.auth) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth, 'utf8').toString('base64');
    }
    var connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: headers,
      agent: false,
      timeout: timeoutMs || adConfig.requestTimeoutMs
    });
    connectReq.once('connect', function (res, socket, head) {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(new Error('proxy CONNECT status ' + res.statusCode));
        return;
      }
      if (head && head.length) { socket.unshift(head); }
      var secure = tls.connect({ socket: socket, servername: targetHost }, function () {
        finish(null, secure);
      });
      secure.once('error', function (err) { finish(err); });
    });
    connectReq.once('timeout', function () {
      connectReq.destroy(new Error('proxy CONNECT timeout'));
    });
    connectReq.once('error', function (err) { finish(err); });
    connectReq.end();
  };
  return agent;
}

function openUpstream(target, options, onResponse, onError) {
  options = options || {};
  var parsed;
  try {
    parsed = new URLCtor(target);
  } catch (e) {
    if (onError) { onError(new Error('bad url')); }
    return null;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !hostAllowed(parsed.hostname)) {
    if (onError) { onError(new Error('forbidden host')); }
    return null;
  }

  var route = options.route || directRoute();
  var targetPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  var headers = {};
  var name;
  for (name in (options.headers || {})) {
    if (Object.prototype.hasOwnProperty.call(options.headers, name)) {
      headers[name] = options.headers[name];
    }
  }
  if (!headers.Accept) { headers.Accept = '*/*'; }
  if (!headers['Accept-Encoding']) { headers['Accept-Encoding'] = 'identity'; }
  if (!headers['User-Agent']) { headers['User-Agent'] = options.userAgent || 'TwellieRelay/2.0'; }
  if (options.body && !headers['Content-Length']) {
    headers['Content-Length'] = Buffer.byteLength(options.body);
  }

  var client = https;
  var agent = upstreamAgent;
  var requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: targetPort,
    path: parsed.pathname + parsed.search,
    method: options.method || 'GET',
    headers: headers,
    timeout: options.timeoutMs || adConfig.requestTimeoutMs || UPSTREAM_TIMEOUT_MS
  };

  if (route.kind === 'proxy' && route.proxy) {
    if (parsed.protocol === 'https:') {
      client = http;
      // The custom agent returns an already-TLS-wrapped socket, so the HTTP
      // client must speak plain HTTP into it (the socket encrypts it).
      requestOptions.protocol = 'http:';
      agent = createProxyAgent(route.proxy, parsed.hostname, targetPort, requestOptions.timeout);
      requestOptions.agent = agent;
    } else {
      client = http;
      agent = false;
      requestOptions.hostname = route.proxy.host;
      requestOptions.port = route.proxy.port;
      requestOptions.path = target;
      requestOptions.headers.Host = parsed.hostname + (parsed.port ? ':' + parsed.port : '');
      if (route.proxy.auth) {
        requestOptions.headers['Proxy-Authorization'] =
          'Basic ' + Buffer.from(route.proxy.auth, 'utf8').toString('base64');
      }
      requestOptions.agent = false;
    }
  } else if (parsed.protocol === 'http:') {
    client = http;
    requestOptions.agent = false;
  } else {
    requestOptions.agent = agent;
  }

  var finished = false;
  var req = client.request(requestOptions, function (res) {
    finished = true;
    onResponse(res, agent);
  });
  if (req.setTimeout) {
    req.setTimeout(requestOptions.timeout, function () {
      req.destroy(new Error('upstream timeout'));
    });
  }
  req.on('error', function (err) {
    if (agent && agent !== upstreamAgent && agent.destroy) { agent.destroy(); }
    if (!finished && onError) { onError(err); }
  });
  if (options.body) { req.write(options.body); }
  req.end();
  return { request: req, agent: agent, parsed: parsed };
}

function fetchBuffered(target, options, callback, redirects) {
  options = options || {};
  redirects = redirects || 0;
  var called = false;
  function done(err, result) {
    if (called) { return; }
    called = true;
    callback(err, result);
  }
  var handle = openUpstream(target, options, function (res, agent) {
    var status = res.statusCode || 502;
    var location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume();
      if (agent && agent !== upstreamAgent && agent.destroy) { agent.destroy(); }
      if (redirects >= MAX_REDIRECTS) {
        done(new Error('too many redirects'));
        return;
      }
      var next;
      try { next = new URLCtor(location, target).href; } catch (e) {
        done(new Error('bad redirect'));
        return;
      }
      fetchBuffered(next, options, callback, redirects + 1);
      return;
    }
    var chunks = [];
    var total = 0;
    var maxBytes = options.maxBytes || MAX_BUFFERED_BYTES;
    res.on('data', function (chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        if (handle && handle.request && handle.request.destroy) { handle.request.destroy(); }
        done(new Error('response too large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', function () {
      if (agent && agent !== upstreamAgent && agent.destroy) { agent.destroy(); }
      var body = Buffer.concat(chunks);
      done(null, {
        status: status,
        headers: res.headers,
        body: body,
        text: body.toString('utf8'),
        finalUrl: target
      });
    });
    res.on('error', function (err) { done(err); });
  }, function (err) { done(err); });
  if (!handle) { done(new Error('upstream request failed')); }
  return handle;
}


function parseStreamInfAttributes(text) {
  var attrs = {};
  var i = 0;
  var key;
  var value;
  var quoted;
  while (i < text.length) {
    while (i < text.length && (text.charAt(i) === ' ' || text.charAt(i) === ',')) { i++; }
    if (i >= text.length) { break; }
    var keyStart = i;
    while (i < text.length && text.charAt(i) !== '=') { i++; }
    if (i >= text.length) { break; }
    key = text.slice(keyStart, i).trim();
    i++;
    quoted = text.charAt(i) === '"';
    if (quoted) { i++; }
    var valueStart = i;
    if (quoted) {
      while (i < text.length && text.charAt(i) !== '"') { i++; }
      value = text.slice(valueStart, i);
      if (i < text.length) { i++; }
    } else {
      while (i < text.length && text.charAt(i) !== ',') { i++; }
      value = text.slice(valueStart, i).trim();
    }
    if (key) { attrs[key] = value; }
  }
  return attrs;
}

function parseUsherManifest(text, baseUrl) {
  var lines = String(text || '').split('\n');
  var entries = [];
  var pending = null;
  var i;
  var line;
  var attrs;
  var resolution;
  var absolute;
  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (line.charAt(line.length - 1) === '\r') { line = line.slice(0, -1); }
    if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
      pending = parseStreamInfAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line && line.charAt(0) !== '#' && pending) {
      try { absolute = new URLCtor(line.trim(), baseUrl).href; } catch (e) { absolute = null; }
      if (absolute && absolute.indexOf('https://') === 0) {
        resolution = String(pending.RESOLUTION || '').split('x');
        entries.push({
          uri: absolute,
          height: Number(resolution[1]) || 0,
          frameRate: Number(pending['FRAME-RATE']) || 0,
          score: Number(pending.SCORE) || 0,
          index: entries.length
        });
      }
      pending = null;
    }
  }
  if (!entries.length) { return null; }
  entries.sort(function (a, b) {
    if (a.score && b.score && a.score !== b.score) { return b.score - a.score; }
    if (a.uri.length !== b.uri.length) { return b.uri.length - a.uri.length; }
    return a.index - b.index;
  });
  var counts = {};
  var map = {};
  var entry;
  var key;
  var count;
  for (i = 0; i < entries.length; i++) {
    entry = entries[i];
    key = entry.height ? (entry.height + 'p' + (entry.frameRate ? Math.round(entry.frameRate) : '')) : ('idx_' + i);
    count = counts[key] || 0;
    counts[key] = count + 1;
    map[count ? key + '_' + count : key] = entry.uri;
  }
  return map;
}

function channelFromUsherUrl(url) {
  try {
    var parsed = new URLCtor(url);
    var match = parsed.pathname.match(/\/hls\/([^/]+)\.m3u8$/i)
;
    return match ? decodeURIComponent(match[1]).toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

function isUsherMasterUrl(url) {
  try {
    var parsed = new URLCtor(url);
    return parsed.hostname.toLowerCase() === 'usher.ttvnw.net' &&
      /\/api\/channel\/hls\/[^/]+\.m3u8$/i.test(parsed.pathname);
  } catch (e) {
    return false;
  }
}

function isVideoWeaverPlaylistUrl(url) {
  try {
    var parsed = new URLCtor(url);
    var host = parsed.hostname.toLowerCase();
    return /\.m3u8$/i.test(parsed.pathname) &&
      (/^[a-z0-9-]+\.playlist\.(live-video|ttvnw)\.net$/i.test(host) ||
       /^video-weaver\.[a-z0-9-]+\.hls\.ttvnw\.net$/i.test(host));
  } catch (e) {
    return false;
  }
}

function containsAd(text) {
  return String(text || '').toLowerCase().indexOf('stitched-ad') >= 0;
}

function anonymizeUsherUrl(usherUrl) {
  try {
    var parsed = new URLCtor(usherUrl);
    if (!adConfig.anonymousMode) { return usherUrl; }
    parsed.searchParams.set('p', String(Math.floor(Math.random() * 10000000)));
    parsed.searchParams.set('play_session_id', generateRandomString(32, true));
    return parsed.toString();
  } catch (e) {
    return usherUrl;
  }
}

function buildReplacementUsherUrl(cachedUsherUrl, token) {
  try {
    var parsed = new URLCtor(cachedUsherUrl);
    parsed.searchParams.set('sig', token.signature);
    parsed.searchParams.set('token', token.value);
    return anonymizeUsherUrl(parsed.toString());
  } catch (e) {
    return cachedUsherUrl;
  }
}

function removeSessionOwners(session, replacementOnly) {
  var url;
  var owner;
  for (url in variantOwners) {
    if (!Object.prototype.hasOwnProperty.call(variantOwners, url)) { continue; }
    owner = variantOwners[url];
    if (owner.sessionId === session.id && (!replacementOnly || owner.replacement)) {
      delete variantOwners[url];
    }
  }
}

function deleteSession(session) {
  var idx;
  if (!session) { return; }
  removeSessionOwners(session, false);
  delete adSessions[String(session.id)];
  idx = adSessionOrder.indexOf(session.id);
  if (idx >= 0) { adSessionOrder.splice(idx, 1); }
}

function pruneSessions() {
  var now = Date.now();
  var i;
  var session;
  for (i = adSessionOrder.length - 1; i >= 0; i--) {
    session = adSessions[String(adSessionOrder[i])];
    if (!session || now - session.lastUsed > SESSION_TTL_MS) {
      if (session) { deleteSession(session); }
      else { adSessionOrder.splice(i, 1); }
    }
  }
  while (adSessionOrder.length > MAX_AD_SESSIONS) {
    session = adSessions[String(adSessionOrder[0])];
    if (session) { deleteSession(session); }
    else { adSessionOrder.shift(); }
  }
}

function registerVariantOwners(session, map, replacement) {
  var quality;
  var url;
  if (!map) { return; }
  for (quality in map) {
    if (!Object.prototype.hasOwnProperty.call(map, quality)) { continue; }
    url = map[quality];
    variantOwners[url] = {
      sessionId: session.id,
      quality: quality,
      replacement: !!replacement
    };
  }
}

function registerSession(channel, usherUrl, assignedMap, route) {
  pruneSessions();
  var session = {
    id: nextSessionId++,
    channel: channel,
    usherUrl: usherUrl,
    assignedMap: assignedMap || {},
    replacementMap: null,
    assignedRoute: route || directRoute(),
    replacementRoute: null,
    consecutiveAdResponses: 0,
    consecutiveAdCooldown: 0,
    replacementInFlight: false,
    replacementWaiters: [],
    lastUsed: Date.now()
  };
  adSessions[String(session.id)] = session;
  adSessionOrder.push(session.id);
  registerVariantOwners(session, session.assignedMap, false);
  pruneSessions();
  return session;
}

function setReplacementMap(session, map, route) {
  removeSessionOwners(session, true);
  session.replacementMap = map || null;
  session.replacementRoute = map ? route : null;
  registerVariantOwners(session, session.replacementMap, true);
  session.lastUsed = Date.now();
}

function findVariantOwner(url) {
  var owner = variantOwners[url];
  if (!owner) { return null; }
  var session = adSessions[String(owner.sessionId)];
  if (!session) {
    delete variantOwners[url];
    return null;
  }
  if (Date.now() - session.lastUsed > SESSION_TTL_MS) {
    deleteSession(session);
    return null;
  }
  session.lastUsed = Date.now();
  return { session: session, quality: owner.quality, replacement: owner.replacement };
}

function candidateRoutes(currentRoute, assignedRoute) {
  var proxies = configuredProxyRoutes();
  var out = [];
  var i;
  var currentIndex = -1;
  var assignedIndex = -1;
  function push(route) {
    var j;
    if (!route) { return; }
    for (j = 0; j < out.length; j++) {
      if (sameRoute(out[j], route)) { return; }
    }
    out.push(route);
  }
  for (i = 0; i < proxies.length; i++) {
    if (sameRoute(proxies[i], currentRoute)) { currentIndex = i; }
    if (sameRoute(proxies[i], assignedRoute)) { assignedIndex = i; }
  }
  if (currentRoute && currentRoute.kind === 'proxy') {
    push(directRoute());
    for (i = currentIndex + 1; i < proxies.length; i++) { push(proxies[i]); }
    for (i = 0; i < currentIndex; i++) { push(proxies[i]); }
  } else {
    var start = assignedIndex >= 0 ? assignedIndex + 1 : 0;
    for (i = start; i < proxies.length; i++) { push(proxies[i]); }
    for (i = 0; i < start && i < proxies.length; i++) { push(proxies[i]); }
    push(directRoute());
  }
  return out.slice(0, adConfig.maxAttempts);
}

function buildPlaybackTokenBody(channel) {
  return JSON.stringify({
    operationName: 'PlaybackAccessToken_Template',
    query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}',
    variables: {
      isLive: true,
      isVod: false,
      login: channel,
      platform: 'web',
      playerType: 'site',
      vodID: ''
    }
  });
}

function fetchPlaybackToken(channel, route, userAgent, callback) {
  fetchBuffered('https://gql.twitch.tv/gql', {
    method: 'POST',
    route: route,
    body: buildPlaybackTokenBody(channel),
    maxBytes: 1024 * 1024,
    timeoutMs: adConfig.requestTimeoutMs,
    headers: {
      'Authorization': 'undefined',
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'text/plain; charset=UTF-8',
      'Device-ID': generateRandomString(32, false),
      'Client-Session-Id': generateRandomString(16, true),
      'Accept': '*/*',
      'User-Agent': userAgent || 'TwellieRelay/2.0'
    }
  }, function (err, result) {
    if (err) { callback(err); return; }
    if (!result || result.status < 200 || result.status >= 300) {
      callback(new Error('playback token HTTP ' + (result ? result.status : 0)));
      return;
    }
    var parsed;
    try { parsed = JSON.parse(result.text); } catch (e) {
      callback(new Error('playback token JSON parse failed'));
      return;
    }
    var token = parsed && parsed.data && parsed.data.streamPlaybackAccessToken;
    if (!token || !token.value || !token.signature) {
      callback(new Error('playback token missing'));
      return;
    }
    if (token.authorization && token.authorization.isForbidden) {
      var forbidden = new Error('playback token forbidden: ' + token.authorization.forbiddenReasonCode);
      forbidden.forbidden = true;
      callback(forbidden);
      return;
    }
    callback(null, token);
  });
}

function fetchMaster(usherUrl, route, userAgent, callback) {
  fetchBuffered(usherUrl, {
    method: 'GET',
    route: route,
    maxBytes: MAX_PLAYLIST_BYTES,
    timeoutMs: adConfig.requestTimeoutMs,
    headers: { Accept: '*/*', 'User-Agent': userAgent || 'TwellieRelay/2.0' }
  }, function (err, result) {
    if (err) { callback(err); return; }
    if (!result || result.status < 200 || result.status >= 300) {
      callback(new Error('usher HTTP ' + (result ? result.status : 0)));
      return;
    }
    var map = parseUsherManifest(result.text, result.finalUrl || usherUrl);
    if (!map) {
      callback(new Error('usher manifest had no variants'));
      return;
    }
    callback(null, { text: result.text, map: map, finalUrl: result.finalUrl || usherUrl, status: result.status });
  });
}

function sendPlaylist(req, res, status, text, baseUrl) {
  var body = String(text || '').indexOf('#EXTM3U') === 0
    ? rewriteM3u8(text, req, baseUrl) : String(text || '');
  var out = Buffer.from(body, 'utf8');
  var headers = corsHeaders(req);
  headers['Content-Type'] = 'application/vnd.apple.mpegurl';
  headers['Content-Length'] = out.length;
  headers['Cache-Control'] = 'no-store';
  if (!res.headersSent) {
    res.writeHead(status || 200, headers);
    res.end(req.method === 'HEAD' ? undefined : out);
  }
}

function routeForFirstPlaylist(route, url) {
  if (!route || route.kind !== 'proxy') { return directRoute(); }
  var count = variantProxyCounts[url] || 0;
  if (count >= 1) { return directRoute(); }
  variantProxyCounts[url] = count + 1;
  return route;
}

function initialRouteList() {
  var routes = configuredProxyRoutes();
  routes.push(directRoute());
  return routes;
}

function handleMasterRequest(req, res, target) {
  var channel = channelFromUsherUrl(target);
  if (!channel) {
    requestUpstream(req, res, target, 0);
    return;
  }
  var routes = initialRouteList();
  var index = 0;
  var lastError = null;
  function attempt() {
    if (index >= routes.length) {
      sendText(req, res, 502, 'usher fetch failed' + (lastError ? ': ' + lastError.message : ''));
      return;
    }
    var route = routes[index++];
    var effectiveTarget = route.kind === 'proxy' ? anonymizeUsherUrl(target) : target;
    fetchBuffered(effectiveTarget, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      route: route,
      maxBytes: MAX_PLAYLIST_BYTES,
      timeoutMs: adConfig.requestTimeoutMs,
      headers: { Accept: req.headers.accept || '*/*' },
      userAgent: req.headers['user-agent']
    }, function (err, result) {
      if (err || !result || result.status < 200 || result.status >= 300) {
        lastError = err || new Error('usher HTTP ' + (result ? result.status : 0));
        attempt();
        return;
      }
      var map = parseUsherManifest(result.text, result.finalUrl || effectiveTarget);
      if (!map) {
        lastError = new Error('usher manifest had no variants');
        attempt();
        return;
      }
      registerSession(channel, result.finalUrl || effectiveTarget, map, route);
      sendPlaylist(req, res, result.status, result.text, result.finalUrl || effectiveTarget);
    });
  }
  attempt();
}

function updateReplacementMap(session, quality, currentRoute, userAgent, callback) {
  if (session.replacementInFlight) {
    session.replacementWaiters.push(callback);
    return;
  }
  session.replacementInFlight = true;
  var routes = candidateRoutes(currentRoute, session.assignedRoute);
  var index = 0;
  var lastError = null;
  function finish(err, data) {
    session.replacementInFlight = false;
    var waiters = session.replacementWaiters;
    session.replacementWaiters = [];
    var i;
    callback(err, data);
    for (i = 0; i < waiters.length; i++) { waiters[i](err, data); }
  }
  function attempt() {
    if (index >= routes.length) {
      finish(lastError || new Error('no ad-free replacement stream'));
      return;
    }
    var route = routes[index++];
    fetchPlaybackToken(session.channel, route, userAgent, function (err, token) {
      if (err) { lastError = err; attempt(); return; }
      var usherUrl = buildReplacementUsherUrl(session.usherUrl, token);
      fetchMaster(usherUrl, route, userAgent, function (masterErr, master) {
        if (masterErr) { lastError = masterErr; attempt(); return; }
        var replacementUrl = master.map[quality];
        if (!replacementUrl) {
          lastError = new Error('replacement quality missing: ' + quality);
          attempt();
          return;
        }
        var variantRoute = routeForFirstPlaylist(route, replacementUrl);
        fetchBuffered(replacementUrl, {
          method: 'GET',
          route: variantRoute,
          maxBytes: MAX_PLAYLIST_BYTES,
          timeoutMs: adConfig.requestTimeoutMs,
          headers: { Accept: '*/*' },
          userAgent: userAgent
        }, function (variantErr, result) {
          if (variantErr || !result || result.status < 200 || result.status >= 300) {
            lastError = variantErr || new Error('replacement variant HTTP ' + (result ? result.status : 0));
            attempt();
            return;
          }
          if (containsAd(result.text)) {
            lastError = new Error('replacement variant still contains ads');
            attempt();
            return;
          }
          setReplacementMap(session, master.map, route);
          finish(null, { route: route, url: replacementUrl, result: result });
        });
      });
    });
  }
  attempt();
}

function handleVariantRequest(req, res, target, found) {
  var session = found.session;
  var quality = found.quality;
  var startedWithReplacement = !!found.replacement;

  function fetchVariant(effectiveTarget, logicalRoute, isReplacement, allowDirectRetry) {
    var fetchRoute = routeForFirstPlaylist(logicalRoute, effectiveTarget);
    fetchBuffered(effectiveTarget, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      route: fetchRoute,
      maxBytes: MAX_PLAYLIST_BYTES,
      timeoutMs: adConfig.requestTimeoutMs,
      headers: { Accept: req.headers.accept || '*/*' },
      userAgent: req.headers['user-agent']
    }, function (err, result) {
      if ((err || !result || result.status >= 500) && fetchRoute.kind === 'proxy' && allowDirectRetry) {
        fetchVariantDirect(effectiveTarget, isReplacement);
        return;
      }
      if (err || !result) {
        sendText(req, res, 502, 'variant fetch failed' + (err ? ': ' + err.message : ''));
        return;
      }
      if (result.status < 200 || result.status >= 300 ||
          String(result.text || '').indexOf('#EXTM3U') !== 0) {
        sendPlaylist(req, res, result.status, result.text, effectiveTarget);
        return;
      }
      if (!containsAd(result.text)) {
        if (session.consecutiveAdCooldown > 0) { session.consecutiveAdCooldown--; }
        else { session.consecutiveAdResponses = 0; }
        sendPlaylist(req, res, result.status, result.text, effectiveTarget);
        return;
      }

      session.consecutiveAdResponses++;
      var adCount = session.consecutiveAdResponses;
      session.consecutiveAdCooldown = adConfig.cooldownResponses;
      if (adCount > 1) {
        if (isReplacement && fetchRoute.kind === 'direct') {
          setReplacementMap(session, null, null);
        }
        sendPlaylist(req, res, result.status, result.text, effectiveTarget);
        return;
      }

      updateReplacementMap(session, quality, fetchRoute, req.headers['user-agent'],
        function (updateErr, data) {
          if (!updateErr && data && data.result) {
            sendPlaylist(req, res, data.result.status, data.result.text, data.url);
            return;
          }
          // No clean alternate assigned stream was available. Preserve
          // playback by serving the original playlist rather than stalling.
          sendPlaylist(req, res, result.status, result.text, effectiveTarget);
        });
    });
  }

  function fetchVariantDirect(effectiveTarget, isReplacement) {
    // Direct retry keeps the logical replacement/assigned identity but does
    // not consume another first-request proxy slot.
    var savedKind = isReplacement;
    fetchBuffered(effectiveTarget, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      route: directRoute(),
      maxBytes: MAX_PLAYLIST_BYTES,
      timeoutMs: adConfig.requestTimeoutMs,
      headers: { Accept: req.headers.accept || '*/*' },
      userAgent: req.headers['user-agent']
    }, function (err, result) {
      if (err || !result) {
        sendText(req, res, 502, 'variant fetch failed' + (err ? ': ' + err.message : ''));
        return;
      }
      if (String(result.text || '').indexOf('#EXTM3U') === 0 && containsAd(result.text) &&
          session.consecutiveAdResponses === 0) {
        session.consecutiveAdResponses++;
        session.consecutiveAdCooldown = adConfig.cooldownResponses;
        updateReplacementMap(session, quality, directRoute(), req.headers['user-agent'],
          function (updateErr, data) {
            if (!updateErr && data && data.result) {
              sendPlaylist(req, res, data.result.status, data.result.text, data.url);
              return;
            }
            sendPlaylist(req, res, result.status, result.text, effectiveTarget);
          });
        return;
      }
      if (String(result.text || '').indexOf('#EXTM3U') === 0 && !containsAd(result.text)) {
        if (session.consecutiveAdCooldown > 0) { session.consecutiveAdCooldown--; }
        else { session.consecutiveAdResponses = 0; }
      }
      sendPlaylist(req, res, result.status, result.text, effectiveTarget);
    });
  }

  var effectiveTarget = target;
  var logicalRoute = startedWithReplacement ? session.replacementRoute : session.assignedRoute;
  if (!startedWithReplacement && session.replacementMap && session.replacementMap[quality]) {
    effectiveTarget = session.replacementMap[quality];
    logicalRoute = session.replacementRoute;
    startedWithReplacement = true;
  }
  fetchVariant(effectiveTarget, logicalRoute || directRoute(), startedWithReplacement, true);
}

function requestUpstream(req, res, target, redirects) {
  var parsed;
  try {
    parsed = new URLCtor(target);
  } catch (e) {
    sendText(req, res, 400, 'bad url');
    return;
  }
  if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname)) {
    sendText(req, res, 403, 'forbidden host');
    return;
  }

  var headers = {
    'Accept': req.headers.accept || '*/*',
    'Accept-Encoding': 'identity',
    'User-Agent': req.headers['user-agent'] || 'TwellieRelay/1.0'
  };
  if (req.headers.range) { headers.Range = req.headers.range; }

  var upstreamReq = https.request({
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: headers,
    agent: upstreamAgent
  }, function (upstreamRes) {
    var status = upstreamRes.statusCode || 502;
    var location = upstreamRes.headers.location;
    if (status >= 300 && status < 400 && location) {
      upstreamRes.resume();
      if (redirects >= MAX_REDIRECTS) {
        sendText(req, res, 502, 'too many redirects');
        return;
      }
      var next;
      try { next = new URLCtor(location, target).href; } catch (e) {
        sendText(req, res, 502, 'bad redirect');
        return;
      }
      requestUpstream(req, res, next, redirects + 1);
      return;
    }

    if (isPlaylist(target, upstreamRes.headers) && req.method !== 'HEAD') {
      var chunks = [];
      var total = 0;
      upstreamRes.on('data', function (chunk) {
        total += chunk.length;
        if (total > MAX_PLAYLIST_BYTES) {
          upstreamReq.destroy();
          sendText(req, res, 502, 'playlist too large');
          return;
        }
        chunks.push(chunk);
      });
      upstreamRes.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8');
        var body = text.indexOf('#EXTM3U') === 0 ? rewriteM3u8(text, req, target) : text;
        var out = Buffer.from(body, 'utf8');
        var responseHeader = corsHeaders(req);
        responseHeader['Content-Type'] = 'application/vnd.apple.mpegurl';
        responseHeader['Content-Length'] = out.length;
        responseHeader['Cache-Control'] = 'no-store';
        if (!res.headersSent) {
          res.writeHead(status, responseHeader);
          res.end(out);
        }
      });
      upstreamRes.on('error', function () {
        if (!res.headersSent) { sendText(req, res, 502, 'upstream error'); }
        else if (res.destroy) { res.destroy(); }
      });
      return;
    }

    if (!res.headersSent) {
      res.writeHead(status, responseHeaders(req, upstreamRes.headers));
    }
    if (req.method === 'HEAD') {
      upstreamRes.resume();
      res.end();
      return;
    }
    upstreamRes.on('error', function () {
      if (res.destroy) { res.destroy(); }
    });
    upstreamRes.pipe(res);
  });

  if (upstreamReq.setTimeout) {
    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, function () {
      upstreamReq.destroy(new Error('upstream timeout'));
    });
  }
  upstreamReq.on('error', function (err) {
    if (!res.headersSent) { sendText(req, res, 502, 'relay error: ' + err.message); }
    else if (res.destroy) { res.destroy(); }
  });
  if (res.on) {
    res.on('close', function () {
      if (upstreamReq.destroy) { upstreamReq.destroy(); }
    });
  }
  upstreamReq.end();
}

function handleHttp(req, res) {
  if (req.method === 'OPTIONS') {
    var headers = corsHeaders(req);
    headers['Access-Control-Max-Age'] = '86400';
    res.writeHead(204, headers);
    res.end();
    return;
  }
  var parsed;
  try {
    parsed = new URLCtor(req.url, 'http://' + PROXY_HOST + ':' + PROXY_PORT);
  } catch (e) {
    sendText(req, res, 400, 'bad request');
    return;
  }
  if (parsed.pathname === '/health') {
    sendText(req, res, 200,
      JSON.stringify({
        ok: true,
        service: 'twellie-proxy',
        version: 2,
        adAvoidance: {
          enabled: !!adConfig.enabled,
          anonymousMode: !!adConfig.anonymousMode,
          upstreamProxies: configuredProxyRoutes().length
        }
      }),
      'application/json; charset=utf-8');
    return;
  }
  if (parsed.pathname !== '/proxy') {
    sendText(req, res, 404, 'not found');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(req, res, 405, 'method not allowed');
    return;
  }
  var target = parsed.searchParams ? parsed.searchParams.get('url') : null;
  if (!target) {
    sendText(req, res, 400, 'missing url');
    return;
  }
  if (adConfig.enabled && isUsherMasterUrl(target)) {
    handleMasterRequest(req, res, target);
    return;
  }
  if (adConfig.enabled && isVideoWeaverPlaylistUrl(target)) {
    var found = findVariantOwner(target);
    if (found) {
      handleVariantRequest(req, res, target, found);
      return;
    }
  }
  requestUpstream(req, res, target, 0);
}

// ---------------------------------------------------------------------------
// SDB TCP relay: LAN -> TV loopback, so a paired PC keeps developer access
// while the TV's Host PC IP stays 127.0.0.1 (TizenBrew's preferred setup).
// Samsung's SDB daemon sees a loopback peer; its RSA authorization still
// applies end to end. Only private/loopback source addresses are accepted.
// ---------------------------------------------------------------------------

var net = require('net');
var RELAY_PORT = 47995;
var SDB_TARGET_HOST = '127.0.0.1';
var SDB_TARGET_PORT = 26101;

function isPrivateIp(address) {
  var ip = String(address || '');
  if (ip.slice(0, 7) === '::ffff:') { ip = ip.slice(7); }
  if (ip === '::1') { return true; }
  var parts = ip.split('.');
  if (parts.length !== 4) { return false; }
  var a = Number(parts[0]);
  var b = Number(parts[1]);
  if (a === 10 || a === 127) { return true; }
  if (a === 192 && b === 168) { return true; }
  if (a === 172 && b >= 16 && b <= 31) { return true; }
  return false;
}

function createSdbRelay(targetHost, targetPort) {
  var host = targetHost || SDB_TARGET_HOST;
  var port = targetPort || SDB_TARGET_PORT;
  return net.createServer(function (client) {
    if (!isPrivateIp(client.remoteAddress)) {
      client.destroy();
      return;
    }
    var upstream = net.connect(port, host);
    client.on('error', function () { upstream.destroy(); });
    upstream.on('error', function () { client.destroy(); });
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

var httpServer = null;
var relayServer = null;

function start(ports) {
  if (ports && ports.adConfig) { configureAdAvoidance(ports.adConfig); }
  var httpPort = (ports && ports.httpPort) || PROXY_PORT;
  var relayPort = (ports && ports.relayPort) || RELAY_PORT;
  if (!httpServer) {
    httpServer = http.createServer(handleHttp);
    httpServer.on('error', function (err) {
      if (typeof console !== 'undefined') { console.log('twellie-proxy http: ' + err.message); }
    });
    httpServer.listen(httpPort, PROXY_HOST, function () {
      if (typeof console !== 'undefined') {
        console.log('twellie-proxy listening on ' + PROXY_HOST + ':' + httpPort);
      }
    });
  }
  if (!relayServer) {
    relayServer = createSdbRelay(SDB_TARGET_HOST, SDB_TARGET_PORT);
    relayServer.on('error', function (err) {
      if (typeof console !== 'undefined') { console.log('twellie-sdb-relay: ' + err.message); }
    });
    relayServer.listen(relayPort, '0.0.0.0', function () {
      if (typeof console !== 'undefined') {
        console.log('twellie-sdb-relay listening on 0.0.0.0:' + relayPort +
          ' -> ' + SDB_TARGET_HOST + ':' + SDB_TARGET_PORT);
      }
    });
  }
  return { httpServer: httpServer, relayServer: relayServer };
}

function stop(done) {
  adSessions = {};
  adSessionOrder = [];
  variantOwners = {};
  variantProxyCounts = {};
  var pending = 2;
  function oneDone() {
    pending -= 1;
    if (pending <= 0 && done) { done(); }
  }
  if (httpServer) { httpServer.close(oneDone); httpServer = null; } else { oneDone(); }
  if (relayServer) { relayServer.close(oneDone); relayServer = null; } else { oneDone(); }
}

function shouldAutoStart() {
  try {
    if (typeof tizen !== 'undefined') { return true; }
  } catch (e) {}
  try {
    return typeof process !== 'undefined' && process.env &&
      process.env.TWELLIE_PROXY_START === '1';
  } catch (e2) {
    return false;
  }
}

var api = {
  PROXY_PORT: PROXY_PORT,
  RELAY_PORT: RELAY_PORT,
  SDB_TARGET_PORT: SDB_TARGET_PORT,
  hostAllowed: hostAllowed,
  isPrivateIp: isPrivateIp,
  configureAdAvoidance: configureAdAvoidance,
  parseProxyUrl: parseProxyUrl,
  parseUsherManifest: parseUsherManifest,
  channelFromUsherUrl: channelFromUsherUrl,
  containsAd: containsAd,
  anonymizeUsherUrl: anonymizeUsherUrl,
  buildReplacementUsherUrl: buildReplacementUsherUrl,
  buildPlaybackTokenBody: buildPlaybackTokenBody,
  candidateRoutes: candidateRoutes,
  fetchBuffered: fetchBuffered,
  rewriteM3u8: rewriteM3u8,
  handleHttp: handleHttp,
  createSdbRelay: createSdbRelay,
  start: start,
  stop: stop
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (shouldAutoStart()) {
  start();
}


