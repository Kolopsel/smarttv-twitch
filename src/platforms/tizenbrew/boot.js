/*!
 * platforms/tizenbrew/boot.js — wire the TizenBrew adapter and start the app.
 *
 * Runs as a plain page inside TizenBrew's webview. Browse and auth go
 * direct (Twitch's gql/api hosts send permissive CORS). Playback is
 * HTML5 <video> with hls.js or native HLS (see platform/player.js),
 * assisted by the module's TV-local relay service.
 *
 * Origin normalisation: TizenBrew serves modules from
 * http://127.0.0.1:8081, and Twitch's playlist CDN rejects that Origin
 * with a 403 while accepting http://localhost:8081. Redirecting to the
 * localhost spelling of the same local server fixes direct playback
 * and costs one reload before the app starts. Stored login state is
 * per-origin, so the move signs the viewer out once.
 */
(function (global) {
  'use strict';

  var TW = global.TW;
  TW.platform = TW.platform || {};

  function normalizeLoopbackOrigin() {
    try {
      var loc = global.location;
      if (loc && loc.hostname === '127.0.0.1' && String(loc.port) === '8081') {
        loc.replace(loc.protocol + '//localhost:' + loc.port +
          loc.pathname + loc.search + loc.hash);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function start() {
    TW.platform.proxyBase = 'http://127.0.0.1:47994';
    TW.app.start({
      name: 'tizenbrew',
      config: {
        screen: { width: 1280, height: 720 }
      },
      keys: TW.platform.keys,
      createPlayer: TW.platform.createPlayer,
      system: TW.platform.system,
      log: function (m) { if (global.console) { global.console.log(m); } }
    });
  }

  if (normalizeLoopbackOrigin()) {
    // Navigation to the localhost origin is in flight; do not start here.
    return;
  }

  if (global.document.readyState !== 'loading') { start(); }
  else { TW.dom.on(global.document, 'DOMContentLoaded', start); }
})(this);
