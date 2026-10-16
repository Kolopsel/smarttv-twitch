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
 */
'use strict';

var http = require('http');
var https = require('https');
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
      JSON.stringify({ ok: true, service: 'twellie-proxy', version: 1 }),
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


