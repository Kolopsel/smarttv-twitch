'use strict';
/*
 * TizenBrew relay ad-session replacement.
 *
 * The relay should parse Twitch's assigned quality map, recognize a
 * server-side stitched ad in a media playlist, mint an anonymous
 * replacement token/session, and serve the matching clean quality
 * instead of the slate. A token Twitch marks forbidden must never be
 * used as a replacement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const api = require('../src/platforms/tizenbrew/proxy-service');

const HTTP_PORT = 48294;
const RELAY_PORT = 48295;

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

function master(variant720, variant480) {
  return '#EXTM3U\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1280x720,FRAME-RATE=60.000,SCORE=9.0,CODECS="avc1.64002A,mp4a.40.2"\n' + variant720 + '\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=852x480,FRAME-RATE=30.000,SCORE=8.0,CODECS="avc1.4D401F,mp4a.40.2"\n' + variant480 + '\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=852x480,FRAME-RATE=30.000,SCORE=7.0,CODECS="avc1.4D401F,mp4a.40.2"\n' + variant480.replace('.m3u8', '-alt.m3u8') + '\n';
}

function fakeAdUpstream(calls) {
  const original = https.request;
  https.request = function (options, cb) {
    const req = new EventEmitter();
    let body = '';
    req.write = function (chunk) { body += chunk; };
    req.setTimeout = function () {};
    req.destroy = function () {};
    req.end = function () {
      calls.push({ options, body });
      const res = new EventEmitter();
      const host = options.hostname;
      const pathValue = String(options.path || '');
      let text = 'segment';
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
      if (host === 'gql.twitch.tv') {
        res.headers = { 'content-type': 'application/json' };
        text = JSON.stringify({
          data: {
            streamPlaybackAccessToken: {
              value: '{"channel":"chan"}',
              signature: 'newsig',
              authorization: { isForbidden: false, forbiddenReasonCode: '' },
            },
          },
        });
      } else if (host === 'usher.ttvnw.net' && pathValue.includes('sig=newsig')) {
        text = master(
          'https://abc.playlist.ttvnw.net/v1/playlist/clean720.m3u8',
          'https://abc.playlist.ttvnw.net/v1/playlist/clean480.m3u8');
      } else if (host === 'usher.ttvnw.net') {
        text = master(
          'https://abc.playlist.ttvnw.net/v1/playlist/ad720.m3u8',
          'https://abc.playlist.ttvnw.net/v1/playlist/ad480.m3u8');
      } else if (pathValue.includes('ad720.m3u8') || pathValue.includes('ad480.m3u8')) {
        text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXT-X-DATERANGE:ID="ad",START="2026-10-21T00:00:00Z",X-TV-TWITCH-WATERMARK="stitched-ad"\n' +
          '#EXTINF:2.0,\nhttps://cdn.cloudfront.net/ad.ts\n';
      } else if (pathValue.includes('clean')) {
        text = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2.0,\nhttps://cdn.cloudfront.net/clean.ts\n';
      }
      cb(res);
      res.emit('data', Buffer.from(text));
      res.emit('end');
    };
    return req;
  };
  return function restore() { https.request = original; };
}

test('proxy parsing, manifest quality mapping, and token anonymization helpers', () => {
  assert.deepEqual(api.parseProxyUrl('chromium.example.test:2023'), {
    protocol: 'http:', host: 'chromium.example.test', port: 2023,
    auth: '', label: 'chromium.example.test:2023',
  });
  assert.equal(api.parseProxyUrl('https://user:pass@example.test:8443'), null);

  const map = api.parseUsherManifest(master(
    'https://abc.playlist.ttvnw.net/v1/playlist/a.m3u8',
    'https://abc.playlist.ttvnw.net/v1/playlist/b.m3u8'),
  'https://usher.ttvnw.net/api/channel/hls/chan.m3u8?sig=x');
  assert.equal(map['720p60'], 'https://abc.playlist.ttvnw.net/v1/playlist/a.m3u8');
  assert.equal(map['480p30'], 'https://abc.playlist.ttvnw.net/v1/playlist/b.m3u8');
  assert.match(map['480p30_1'], /b-alt\.m3u8/);

  const body = JSON.parse(api.buildPlaybackTokenBody('chan'));
  assert.equal(body.operationName, 'PlaybackAccessToken_Template');
  assert.equal(body.variables.login, 'chan');
  assert.equal(body.variables.playerType, 'site');

  const replaced = new URL(api.buildReplacementUsherUrl(
    'https://usher.ttvnw.net/api/channel/hls/chan.m3u8?sig=old&token=old&p=1&platform=web',
    { value: 'newvalue', signature: 'newsig' }));
  assert.equal(replaced.searchParams.get('sig'), 'newsig');
  assert.equal(replaced.searchParams.get('token'), 'newvalue');
  assert.match(replaced.searchParams.get('play_session_id'), /^[a-z0-9]{32}$/);
  assert.equal(replaced.searchParams.get('platform'), 'web');

  api.configureAdAvoidance({ proxies: ['http://one.example.test:8080', 'http://two.example.test:8080'], maxAttempts: 3 });
  const proxies = [
    { kind: 'proxy', id: 'proxy-0', proxy: api.parseProxyUrl('one.example.test:8080') },
    { kind: 'proxy', id: 'proxy-1', proxy: api.parseProxyUrl('two.example.test:8080') },
  ];
  assert.deepEqual(api.candidateRoutes(proxies[0], proxies[0]).map((r) => r.id), ['direct', 'proxy-1']);
  assert.deepEqual(api.candidateRoutes({ kind: 'direct', id: 'direct' }, proxies[0]).map((r) => r.id),
    ['proxy-1', 'proxy-0', 'direct']);
});

test('relay replaces an ad playlist with a clean same-quality assigned stream', async () => {
  const calls = [];
  const restore = fakeAdUpstream(calls);
  api.start({
    httpPort: HTTP_PORT,
    relayPort: RELAY_PORT,
    adConfig: { enabled: true, proxies: [], maxAttempts: 2, requestTimeoutMs: 2000, cooldownResponses: 15 },
  });
  try {
    const assignedUsher = 'https://usher.ttvnw.net/api/channel/hls/chan.m3u8?sig=oldsig&token=oldtoken&platform=web';
    const masterResponse = await httpGet(
      'http://127.0.0.1:' + HTTP_PORT + '/proxy?url=' + encodeURIComponent(assignedUsher),
      { Origin: 'http://127.0.0.1:8081' });
    assert.equal(masterResponse.status, 200);
    const localVariant = masterResponse.body.split('\n').find((line) => line.includes('ad720.m3u8'));
    assert.ok(localVariant, masterResponse.body);

    const first = await httpGet(localVariant, { Origin: 'http://127.0.0.1:8081' });
    assert.equal(first.status, 200);
    assert.doesNotMatch(first.body, /stitched-ad/i);
    assert.match(first.body, /clean\.ts/);

    const tokenCalls = () => calls.filter((c) => c.options.hostname === 'gql.twitch.tv');
    assert.equal(tokenCalls().length, 1);
    assert.match(tokenCalls()[0].body, /PlaybackAccessToken_Template/);
    assert.equal(tokenCalls()[0].options.headers.Authorization, 'undefined');
    assert.match(tokenCalls()[0].options.headers['Device-ID'], /^[A-Za-z0-9]{32}$/);
    assert.equal(tokenCalls()[0].options.headers.Origin, undefined);

    const second = await httpGet(localVariant, { Origin: 'http://127.0.0.1:8081' });
    assert.equal(second.status, 200);
    assert.doesNotMatch(second.body, /stitched-ad/i);
    assert.equal(tokenCalls().length, 1, 'replacement map is reused without another token request');
  } finally {
    restore();
    await new Promise((resolve) => api.stop(resolve));
  }
});
