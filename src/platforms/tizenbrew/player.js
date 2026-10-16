/*!
 * platforms/tizenbrew/player.js — HLS playback for the TizenBrew module.
 *
 * TizenBrew loads this page as a plain document in its webview and does NOT
 * expose webapis.avplay to it, so playback uses HTML5 <video> with hls.js
 * (Media Source Extensions) or the TV's native HLS support.
 *
 * Twitch's playlist CDN rejects browser fetches whose Origin is
 * http://127.0.0.1:8081 (TizenBrew's local serve origin) with a 403, while
 * allowing no Origin, a localhost Origin, or a twitch.tv Origin (verified
 * 2026-10-15). Two defences, in order:
 *   1. boot.js normalises the page origin to http://localhost:8081, which
 *      the CDN accepts, so direct playback can work on its own.
 *   2. This module's serviceFile (platform/proxy-service.js in the built
 *      package) runs a TV-local Node relay that fetches the HLS chain
 *      server-side with no browser Origin at all.
 * The player health-checks the relay, then tries, in order: hls.js via
 * relay, hls.js direct, native via relay, native direct — moving on only
 * when an attempt fails before playback starts. Quality selection works
 * on the hls.js attempts; native attempts report Auto only.
 */
(function (global) {
  'use strict';

  var TW = global.TW;
  TW.platform = TW.platform || {};

  var DEFAULT_PROXY_BASE = 'http://127.0.0.1:47994';

  function labelFor(level, idx) {
    if (level.height) {
      var fr = level.frameRate || (level.attrs && parseFloat(level.attrs['FRAME-RATE']));
      return level.height + 'p' + (fr && fr > 35 ? Math.round(fr) : '');
    }
    if (level.bitrate) { return Math.round(level.bitrate / 1000) + 'k'; }
    return 'q' + idx;
  }

  function createPlayer(cb) {
    var Hls = global.Hls;
    var video = TW.dom.get('tw-video');
    var hls = null;
    var qualities = ['Auto'];
    var levelMap = [-1];        // quality index -> hls level index (-1 = auto)
    var qcb = null;
    var baseW = 0, baseH = 0;
    var pendingSeek = null;
    var seekTimer = null;
    var mediaActive = false;
    var proxyState = 'unknown'; // unknown | checking | ready | unavailable
    var proxyWaiters = [];
    var loadSeq = 0;
    var attempts = [];
    var currentAttempt = -1;
    var attemptProgress = false;
    var currentRawUrl = null;
    var currentIsVod = false;
    var clipActive = false;

    function proxyBase() {
      var base = TW.platform.proxyBase || DEFAULT_PROXY_BASE;
      return String(base).replace(/\/$/, '');
    }

    function viaProxy(url) {
      return proxyBase() + '/proxy?url=' + encodeURIComponent(url);
    }

    function canNativeHls() {
      try { return !!video.canPlayType('application/vnd.apple.mpegurl'); } catch (e) { return false; }
    }

    function hlsSupported() {
      try { return !!(Hls && Hls.isSupported && Hls.isSupported()); } catch (e) { return false; }
    }

    function delay(ms, fn) {
      if (global.setTimeout) { global.setTimeout(fn, ms); }
      else { fn(); }
    }

    function finishProxy(ok) {
      proxyState = ok ? 'ready' : 'unavailable';
      var waiters = proxyWaiters;
      proxyWaiters = [];
      for (var i = 0; i < waiters.length; i++) { waiters[i](ok); }
    }

    // The module service fetches its script and binds its port shortly after
    // TizenBrew launches the module, so allow a few short retries before
    // declaring the relay unavailable for this player instance.
    function ensureProxy(done) {
      if (proxyState === 'ready') { done(true); return; }
      if (proxyState === 'unavailable') { done(false); return; }
      proxyWaiters.push(done);
      if (proxyState === 'checking') { return; }
      if (!global.XMLHttpRequest) { finishProxy(false); return; }
      proxyState = 'checking';
      var tries = 0;
      function fail() {
        tries += 1;
        if (tries >= 4) { finishProxy(false); return; }
        delay(350, tryOnce);
      }
      function tryOnce() {
        var xhr;
        var finished = false;
        function failOnce() {
          if (finished) { return; }
          finished = true;
          fail();
        }
        try {
          xhr = new global.XMLHttpRequest();
          xhr.open('GET', proxyBase() + '/health?ts=' + (new Date().getTime()), true);
          try { xhr.timeout = 900; } catch (e) {}
          xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || finished) { return; }
            if (xhr.status >= 200 && xhr.status < 300 &&
              String(xhr.responseText || '').indexOf('twellie-proxy') >= 0) {
              finished = true;
              finishProxy(true);
            } else {
              failOnce();
            }
          };
          xhr.onerror = failOnce;
          xhr.ontimeout = failOnce;
          xhr.send(null);
        } catch (e2) {
          failOnce();
        }
      }
      tryOnce();
    }

    function publishQualities() {
      if (qcb) { qcb(qualities); }
    }

    function displayBase() {
      if (!baseW || !baseH) {
        var p = video.parentNode;
        baseW = (p && p.offsetWidth) || video.offsetWidth || TW.config.screen.width;
        baseH = (p && p.offsetHeight) || video.offsetHeight || TW.config.screen.height;
      }
    }

    function setVideoRect(x, y, w, h) {
      displayBase();
      video.style.position = 'absolute';
      video.style.left = Math.round(x * baseW / TW.config.screen.width) + 'px';
      video.style.top = Math.round(y * baseH / TW.config.screen.height) + 'px';
      video.style.width = Math.round(w * baseW / TW.config.screen.width) + 'px';
      video.style.height = Math.round(h * baseH / TW.config.screen.height) + 'px';
      video.style.objectFit = 'contain';
    }

    TW.dom.on(video, 'waiting', function () { cb.onBufferingStart(); });
    TW.dom.on(video, 'playing', function () {
      attemptProgress = true;
      cb.onBufferingComplete();
      cb.onPlaying();
    });
    TW.dom.on(video, 'ended', function () { cb.onEnded(); });
    TW.dom.on(video, 'error', function () {
      if (!mediaActive) { return; }
      if (clipActive) {
        cb.onError(TW.i18n.t('ERROR_RENDER'));
        return;
      }
      var attempt = attempts[currentAttempt];
      if (attempt && attempt.kind === 'native') {
        if (!attemptProgress) { failAttempt(loadSeq, currentAttempt); }
        else { cb.onError(TW.i18n.t('ERROR_RENDER')); }
      }
      // hls.js attempts report through Hls.Events.ERROR instead.
    });

    function playFromStartIfVod(isVod) {
      if (isVod) {
        try { video.currentTime = 0; } catch (e) {}
      }
      video.play();
    }

    function duration() {
      var d = video.duration || 0;
      return d > 0 && d < 1000000000 ? d : 0;
    }

    function clearPendingSeek() {
      if (seekTimer) { global.clearTimeout(seekTimer); seekTimer = null; }
      pendingSeek = null;
    }

    function commitSeek() {
      if (seekTimer) { global.clearTimeout(seekTimer); seekTimer = null; }
      var t = pendingSeek;
      pendingSeek = null;
      if (t == null) { return; }
      try { video.currentTime = t; } catch (e) {}
    }

    function scheduleSeek(t) {
      pendingSeek = t;
      if (seekTimer) { global.clearTimeout(seekTimer); }
      seekTimer = global.setTimeout(commitSeek, 280);
    }

    function destroyHls() {
      try { if (hls) { hls.destroy(); hls = null; } } catch (e) { hls = null; }
    }

    function buildAttempts(proxyOk) {
      var list = [];
      var mse = hlsSupported();
      var native = canNativeHls();
      if (proxyOk && mse) { list.push({ kind: 'hls', url: viaProxy(currentRawUrl) }); }
      if (mse) { list.push({ kind: 'hls', url: currentRawUrl }); }
      if (proxyOk && native) { list.push({ kind: 'native', url: viaProxy(currentRawUrl) }); }
      if (native) { list.push({ kind: 'native', url: currentRawUrl }); }
      return list;
    }

    function failAttempt(seq, index) {
      if (seq !== loadSeq || index !== currentAttempt || !mediaActive) { return; }
      runAttempt(seq, index + 1);
    }

    function runAttempt(seq, index) {
      if (seq !== loadSeq || !mediaActive) { return; }
      if (index >= attempts.length) {
        cb.onError(attempts.length ? TW.i18n.t('ERROR_RENDER') : 'HLS not supported on this TV');
        return;
      }
      currentAttempt = index;
      attemptProgress = false;
      qualities = ['Auto'];
      levelMap = [-1];
      destroyHls();
      try { video.onloadedmetadata = null; } catch (e) {}
      var attempt = attempts[index];
      var isVod = currentIsVod;

      if (attempt.kind === 'hls') {
        hls = new Hls({ lowLatencyMode: !isVod, startPosition: isVod ? 0 : -1 });
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          if (seq !== loadSeq || index !== currentAttempt) { return; }
          attemptProgress = true;
          // Twitch lists source first; present highest-first after "Auto".
          var levels = hls.levels.slice();
          var order = [];
          for (var i = 0; i < levels.length; i++) { order.push(i); }
          order.sort(function (a, b) { return (levels[b].height || 0) - (levels[a].height || 0); });
          qualities = ['Auto']; levelMap = [-1];
          for (var k = 0; k < order.length; k++) {
            qualities.push(labelFor(levels[order[k]], order[k]));
            levelMap.push(order[k]);
          }
          publishQualities();
          playFromStartIfVod(isVod);
        });
        hls.on(Hls.Events.ERROR, function (e, data) {
          if (seq !== loadSeq || index !== currentAttempt) { return; }
          if (data && data.fatal) {
            if (!attemptProgress) { failAttempt(seq, index); }
            else { cb.onError(TW.i18n.t('ERROR_RENDER')); }
          }
        });
        hls.loadSource(attempt.url);
        hls.attachMedia(video);
        return;
      }

      // Native HLS attempt.
      video.onloadedmetadata = function () {
        if (seq !== loadSeq || index !== currentAttempt) { return; }
        attemptProgress = true;
        playFromStartIfVod(isVod);
      };
      video.src = attempt.url;
      publishQualities();
    }

    return {
      load: function (rawUrl) {
        loadSeq += 1;
        var seq = loadSeq;
        currentRawUrl = rawUrl;
        currentIsVod = rawUrl.indexOf('/vod/') >= 0;
        mediaActive = true;
        clipActive = false;
        attempts = [];
        currentAttempt = -1;
        attemptProgress = false;

        // Clips are a progressive MP4, not HLS — play them on the <video>
        // element directly (single quality). Live + VODs are HLS (.m3u8).
        if (rawUrl.indexOf('.m3u8') < 0) {
          clipActive = true;
          destroyHls();
          qualities = ['Source']; levelMap = [-1]; publishQualities();
          video.src = rawUrl;
          try { video.currentTime = 0; } catch (e) {}
          video.play();
          return;
        }

        ensureProxy(function (proxyOk) {
          if (seq !== loadSeq || !mediaActive) { return; }
          attempts = buildAttempts(proxyOk);
          runAttempt(seq, 0);
        });
      },
      stop: function () {
        loadSeq += 1;
        mediaActive = false;
        clipActive = false;
        attempts = [];
        currentAttempt = -1;
        try {
          clearPendingSeek();
          destroyHls();
          try { video.onloadedmetadata = null; } catch (e) {}
          video.removeAttribute('src');
          video.load();
        } catch (e2) {}
      },
      destroy: function () { this.stop(); },
      setDisplayArea: setVideoRect,
      getQualities: function (fn) { qcb = fn; fn(qualities); },
      selectQuality: function (i) { if (hls) { hls.currentLevel = levelMap[i] != null ? levelMap[i] : -1; } },
      canSeek: function () { return true; },
      getPosition: function () { return Math.max(0, pendingSeek != null ? pendingSeek : (video.currentTime || 0)); },
      getDuration: duration,
      seekTo: function (seconds) {
        var d = duration();
        var t = Math.max(0, seconds || 0);
        if (d > 0 && t > d) { t = d; }
        scheduleSeek(t);
      },
      commitSeek: commitSeek,
      pause: function () { try { video.pause(); } catch (e) {} },
      resume: function () { try { video.play(); } catch (e) {} }
    };
  }

  TW.platform.createPlayer = createPlayer;
})(this);


