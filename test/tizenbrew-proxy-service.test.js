'use strict';
/*
 * TizenBrew relay service (serviceFile): HLS HTTP relay + SDB TCP relay.
 *
 * The service must fetch the HLS chain server-side (no browser Origin,
 * which Twitch's playlist CDN rejects from the TizenBrew page origin),
 * rewrite playlists back through itself, stay closed to non-Twitch
 * hosts, and only accept SDB relay connections from private addresses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const net = require('net');
const { EventEmitter } = require('events');
const api = require('../src/platforms/tizenbrew/proxy-service');

const HTTP_PORT = 48194;
const RELAY_PORT = 48195;
const ECHO_PORT = 48196;
const RELAY_TEST_PORT = 48197;

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

function fakeUpstream(calls) {
  const original = https.request;
  https.request = function (options, cb) {
    const req = new EventEmitter();
    calls.push(options);
    req.write = function () {};
    req.setTimeout = function () {};
    req.destroy = function () {};
    req.end = function () {
      const res = new EventEmitter();
      const isMaster = String(options.path).indexOf('master.m3u8') >= 0;
      res.statusCode = 200;
      res.headers = isMaster
        ? { 'content-type': 'application/vnd.apple.mpegurl' }
        : {
            'content-type': 'video/mp2t', 'content-range': 'bytes 0-6/100',
            'accept-ranges': 'bytes', 'content-length': '7',
          };
      cb(res);
      res.emit('data', Buffer.from(isMaster
        ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant/index.m3u8\nsegment.ts\n'
        : 'segment'));
      res.emit('end');
    };
    return req;
  };
  return function restore() { https.request = original; };
}

test('host allowlist and private-address gate', () => {
  assert.equal(api.hostAllowed('usher.ttvnw.net'), true);
  assert.equal(api.hostAllowed('euc12.playlist.ttvnw.net'), true);
  assert.equal(api.hostAllowed('video-weaver.hls.live-video.net'), true);
  assert.equal(api.hostAllowed('evilttvnw.net'), false);
  assert.equal(api.hostAllowed('example.com'), false);

  assert.equal(api.isPrivateIp('192.168.1.240'), true);
  assert.equal(api.isPrivateIp('::ffff:192.168.1.240'), true);
  assert.equal(api.isPrivateIp('127.0.0.1'), true);
  assert.equal(api.isPrivateIp('172.20.0.5'), true);
  assert.equal(api.isPrivateIp('8.8.8.8'), false);
  assert.equal(api.isPrivateIp(''), false);
});

test('playlist rewriting routes nested URIs back through the relay', () => {
  const req = { headers: { host: '127.0.0.1:' + HTTP_PORT } };
  const out = api.rewriteM3u8(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\nsegment.ts\n',
    req, 'https://usher.ttvnw.net/api/channel/hls/chan.m3u8?sig=x');
  assert.match(out, /127\.0\.0\.1:48194\/proxy\?url=https%3A%2F%2Fusher\.ttvnw\.net%2Fapi%2Fchannel%2Fhls%2Faudio%2Findex\.m3u8/);
  assert.match(out, /proxy\?url=https%3A%2F%2Fusher\.ttvnw\.net%2Fapi%2Fchannel%2Fhls%2Fsegment\.ts/);
});

test('relay serves health + a rewritten playlist without forwarding Origin, and pipes SDB traffic', async () => {
  const calls = [];
  const restore = fakeUpstream(calls);
  const echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => echo.listen(ECHO_PORT, '127.0.0.1', resolve));
  const relay = api.createSdbRelay('127.0.0.1', ECHO_PORT);
  await new Promise((resolve) => relay.listen(RELAY_TEST_PORT, '127.0.0.1', resolve));
  api.start({ httpPort: HTTP_PORT, relayPort: RELAY_PORT, adConfig: { enabled: false, proxies: [] } });
  try {
    const health = await httpGet('http://127.0.0.1:' + HTTP_PORT + '/health');
    assert.equal(health.status, 200);
    assert.match(health.body, /twellie-proxy/);

    const master = 'https://usher.ttvnw.net/api/channel/hls/master.m3u8?sig=x&token=y';
    const playlist = await httpGet(
      'http://127.0.0.1:' + HTTP_PORT + '/proxy?url=' + encodeURIComponent(master),
      { Origin: 'http://127.0.0.1:8081', Range: 'bytes=0-6' });
    assert.equal(playlist.status, 200);
    assert.match(playlist.body, /\/proxy\?url=https%3A%2F%2Fusher\.ttvnw\.net%2Fapi%2Fchannel%2Fhls%2Fvariant%2Findex\.m3u8/);
    assert.equal(calls[0].headers.Origin, undefined);
    assert.equal(calls[0].headers.Range, 'bytes=0-6');

    const forbidden = await httpGet(
      'http://127.0.0.1:' + HTTP_PORT + '/proxy?url=' + encodeURIComponent('https://example.com/x.m3u8'));
    assert.equal(forbidden.status, 403);

    const echoed = await new Promise((resolve, reject) => {
      const client = net.connect(RELAY_TEST_PORT, '127.0.0.1', () => client.write('ping-sdb'));
      client.once('data', (data) => { client.end(); resolve(data.toString()); });
      client.once('error', reject);
    });
    assert.equal(echoed, 'ping-sdb');
  } finally {
    restore();
    await new Promise((resolve) => api.stop(resolve));
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
  }
});
