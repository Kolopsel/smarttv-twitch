'use strict';
/*
 * TizenBrew boot: loopback origin normalisation.
 *
 * TizenBrew serves modules from http://127.0.0.1:8081, whose Origin
 * Twitch's playlist CDN rejects with 403, while the localhost spelling
 * of the same server is accepted. Boot must redirect 127.0.0.1:8081 to
 * localhost:8081 before starting the app, and start normally elsewhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = 'src/platforms/tizenbrew/boot.js';

function runBoot(url) {
  const u = new URL(url);
  const starts = [];
  const replaced = [];
  const g = {
    location: {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      replace(target) { replaced.push(target); },
    },
    document: { readyState: 'complete' },
    console: { log() {} },
    TW: {
      platform: { keys: {}, system: {}, createPlayer() {} },
      dom: { on() {} },
      app: { start(opts) { starts.push(opts); } },
    },
  };
  g.window = g; g.self = g; g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', FILE), 'utf8'), g, { filename: FILE });
  return { TW: g.TW, starts, replaced };
}

test('127.0.0.1:8081 redirects to the localhost spelling and does not start', () => {
  const { starts, replaced } = runBoot('http://127.0.0.1:8081/module/gh%2FKolopsel%2Fsmarttv-twitch/tizenbrew/index.html?x=1#top');
  assert.deepEqual(replaced, [
    'http://localhost:8081/module/gh%2FKolopsel%2Fsmarttv-twitch/tizenbrew/index.html?x=1#top',
  ]);
  assert.equal(starts.length, 0);
});

test('localhost:8081 starts the app with the relay proxy base', () => {
  const { TW, starts, replaced } = runBoot('http://localhost:8081/module/gh%2FKolopsel%2Fsmarttv-twitch/tizenbrew/index.html');
  assert.deepEqual(replaced, []);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].name, 'tizenbrew');
  assert.equal(TW.platform.proxyBase, 'http://127.0.0.1:47994');
});

test('other loopback ports are left alone', () => {
  const { starts, replaced } = runBoot('http://127.0.0.1:8080/index.html');
  assert.deepEqual(replaced, []);
  assert.equal(starts.length, 1);
});
