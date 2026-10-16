'use strict';
/*
 * TizenBrew player route selection.
 *
 * Twitch's playlist CDN returns 403 to browser fetches whose Origin is
 * http://127.0.0.1:8081 (the origin TizenBrew serves modules from). The
 * player therefore routes the HLS chain through the module's TV-local
 * relay service when it answers its health check, and otherwise falls
 * back step by step: hls.js via relay, hls.js direct, native via relay,
 * native direct. An attempt that fails before playback starts moves on
 * to the next route instead of surfacing an error.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = 'src/platforms/tizenbrew/player.js';
const HLS_URL = 'https://usher.example.test/api/channel/hls/somechan.m3u8?sig=x&token=y';
const PROXIED = 'http://127.0.0.1:47994/proxy?url=' + encodeURIComponent(HLS_URL);

function makeVideo(canPlay) {
  return {
    currentTime: 0,
    duration: 0,
    offsetWidth: 1280,
    offsetHeight: 720,
    parentNode: { offsetWidth: 1280, offsetHeight: 720 },
    style: {},
    canPlayType() { return canPlay; },
    play() {},
    pause() {},
    removeAttribute() {},
    load() {},
  };
}

function makeHlsStub(record) {
  function HlsStub() {
    record.constructed += 1;
    this.levels = [];
    this.handlers = {};
    record.instances.push(this);
  }
  HlsStub.isSupported = () => true;
  HlsStub.Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'error' };
  HlsStub.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };
  HlsStub.prototype.loadSource = function (url) { record.loaded.push(url); };
  HlsStub.prototype.attachMedia = function () {};
  HlsStub.prototype.destroy = function () { record.destroyed += 1; };
  return HlsStub;
}

function makeFakeXhr(mode, calls) {
  return class FakeXMLHttpRequest {
    open(method, url) { this.url = url; calls.push(url); }
    send() {
      this.readyState = 4;
      if (mode === 'ready') {
        this.status = 200;
        this.responseText = '{"ok":true,"service":"twellie-proxy","version":1}';
      } else {
        this.status = 0;
        this.responseText = '';
      }
      if (this.onreadystatechange) { this.onreadystatechange(); }
    }
  };
}

function loadPlayer({ canPlay, withHls, proxy }) {
  const video = makeVideo(canPlay);
  const record = { constructed: 0, loaded: [], destroyed: 0, instances: [] };
  const handlers = {};
  const errors = [];
  const timers = [];
  const xhrCalls = [];
  const g = {
    Hls: withHls ? makeHlsStub(record) : null,
    TW: {
      config: { screen: { width: 1280, height: 720 } },
      dom: {
        get() { return video; },
        on(el, ev, fn) { handlers[ev] = fn; },
      },
      i18n: { t: (k) => k },
      platform: {},
    },
    setTimeout(fn, ms) {
      const id = timers.length + 1;
      timers.push({ id, fn, ms, active: true });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find((item) => item.id === id);
      if (t) { t.active = false; }
    },
  };
  if (proxy && proxy !== 'none') { g.XMLHttpRequest = makeFakeXhr(proxy, xhrCalls); }
  g.window = g; g.self = g; g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', FILE), 'utf8'), g, { filename: FILE });
  const player = g.TW.platform.createPlayer({
    onBufferingStart() {},
    onBufferingComplete() {},
    onPlaying() {},
    onEnded() {},
    onError(msg) { errors.push(msg); },
  });
  function flushTimers() {
    for (let rounds = 0; rounds < 50; rounds++) {
      const next = timers.find((t) => t.active);
      if (!next) { return; }
      next.active = false;
      next.fn();
    }
    throw new Error('timer flush did not settle');
  }
  return { player, video, record, handlers, errors, xhrCalls, flushTimers };
}

test('healthy relay: hls.js loads the master through the relay', () => {
  const { player, video, record } = loadPlayer({ canPlay: 'probably', withHls: true, proxy: 'ready' });
  player.load(HLS_URL);
  assert.equal(record.constructed, 1);
  assert.deepEqual(record.loaded, [PROXIED]);
  assert.equal(video.src, undefined);
});

test('healthy relay: a fatal hls.js error before playback falls back to direct hls.js', () => {
  const { player, record } = loadPlayer({ canPlay: '', withHls: true, proxy: 'ready' });
  player.load(HLS_URL);
  record.instances[0].handlers.error(null, { fatal: true });
  assert.equal(record.constructed, 2);
  assert.deepEqual(record.loaded, [PROXIED, HLS_URL]);
});

test('relay down: retries the health check, then uses native direct', () => {
  const { player, video, xhrCalls, flushTimers } = loadPlayer({ canPlay: 'probably', withHls: false, proxy: 'down' });
  player.load(HLS_URL);
  flushTimers();
  assert.equal(xhrCalls.length, 4);
  assert.equal(video.src, HLS_URL);
});

test('no XHR available: native direct without a health check', () => {
  const { player, video, record } = loadPlayer({ canPlay: 'probably', withHls: true, proxy: 'none' });
  player.load(HLS_URL);
  // hls.js direct is still first when MSE exists and no relay is known.
  assert.equal(record.constructed, 1);
  assert.deepEqual(record.loaded, [HLS_URL]);
  assert.equal(video.src, undefined);
});

test('neither native nor hls.js surfaces the unsupported error', () => {
  const { player, errors } = loadPlayer({ canPlay: '', withHls: false, proxy: 'none' });
  player.load(HLS_URL);
  assert.deepEqual(errors, ['HLS not supported on this TV']);
});

test('native media errors move to the next route, and stop() silences late errors', () => {
  const { player, video, handlers, errors } = loadPlayer({ canPlay: 'probably', withHls: false, proxy: 'none' });
  player.load(HLS_URL);
  assert.equal(video.src, HLS_URL);
  handlers.error(); // only one route exists, so this surfaces
  assert.deepEqual(errors, ['ERROR_RENDER']);
  player.stop();
  handlers.error();
  assert.deepEqual(errors, ['ERROR_RENDER']);
});

test('clips stay on the direct progressive path', () => {
  const { player, video, record } = loadPlayer({ canPlay: 'probably', withHls: true, proxy: 'ready' });
  player.load('https://clips.example.test/clip.mp4?sig=x');
  assert.equal(video.src, 'https://clips.example.test/clip.mp4?sig=x');
  assert.equal(record.constructed, 0);
});
