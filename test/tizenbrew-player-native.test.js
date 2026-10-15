'use strict';
/*
 * TizenBrew player route selection.
 *
 * Twitch's playlist CDN returns 403 to browser fetches whose Origin is
 * http://127.0.0.1:8081 (the origin TizenBrew serves modules from), which
 * breaks every hls.js load on the TV. The player must therefore prefer the
 * TV's native <video> HLS path and keep hls.js only as a fallback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = 'src/platforms/tizenbrew/player.js';
const HLS_URL = 'https://usher.example.test/api/channel/hls/somechan.m3u8?sig=x&token=y';

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
  }
  HlsStub.isSupported = () => true;
  HlsStub.Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'error' };
  HlsStub.prototype.on = function () {};
  HlsStub.prototype.loadSource = function (url) { record.loaded.push(url); };
  HlsStub.prototype.attachMedia = function () {};
  HlsStub.prototype.destroy = function () { record.destroyed += 1; };
  return HlsStub;
}

function loadPlayer({ canPlay, withHls }) {
  const video = makeVideo(canPlay);
  const record = { constructed: 0, loaded: [], destroyed: 0 };
  const handlers = {};
  const errors = [];
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
    setTimeout() { return 1; },
    clearTimeout() {},
  };
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
  return { player, video, record, handlers, errors };
}

test('native HLS is preferred over hls.js when the TV reports support', () => {
  const { player, video, record } = loadPlayer({ canPlay: 'probably', withHls: true });
  player.load(HLS_URL);
  assert.equal(video.src, HLS_URL);
  assert.equal(record.constructed, 0);
  let qualities = null;
  player.getQualities((q) => { qualities = q; });
  assert.deepEqual(Array.prototype.slice.call(qualities), ['Auto']);
});

test('hls.js is the fallback when native HLS is unavailable', () => {
  const { player, video, record } = loadPlayer({ canPlay: '', withHls: true });
  player.load(HLS_URL);
  assert.equal(record.constructed, 1);
  assert.deepEqual(record.loaded, [HLS_URL]);
  assert.equal(video.src, undefined);
});

test('neither native nor hls.js surfaces the unsupported error', () => {
  const { player, errors } = loadPlayer({ canPlay: '', withHls: false });
  player.load(HLS_URL);
  assert.deepEqual(errors, ['HLS not supported on this TV']);
});

test('media errors surface while playing but not after stop', () => {
  const { player, handlers, errors } = loadPlayer({ canPlay: 'probably', withHls: true });
  player.load(HLS_URL);
  handlers.error();
  assert.deepEqual(errors, ['ERROR_RENDER']);
  player.stop();
  handlers.error();
  assert.deepEqual(errors, ['ERROR_RENDER']);
});
