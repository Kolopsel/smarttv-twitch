'use strict';
/*
 * Skin contract for the re-designed TV UI ("Midnight" look).
 *
 * The fork's visual refresh lives entirely in src/ui/styles.css and must not
 * disturb the geometry the scenes measure at runtime, the white 10-foot focus
 * indicator, or the old-WebKit constraints (no flex/grid/vw/custom props).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.resolve(__dirname, '..', 'src/ui/styles.css'), 'utf8');
const BRAND = '#9146ff'; // Twitch purple — the service's own brand colour.

test('brand accent marks the active tab, playback progress, account chip and login action', () => {
  assert.match(CSS, new RegExp('\\.tw-tip-active \\.tw-tip-box\\s*\\{[^}]*border-bottom-color: ' + BRAND + ';', 's'));
  assert.match(CSS, new RegExp('\\.tw-progress-fill\\s*\\{[^}]*background: ' + BRAND + ';', 's'));
  assert.match(CSS, new RegExp('\\.tw-account\\s*\\{[^}]*background: ' + BRAND + ';', 's'));
  assert.match(CSS, new RegExp('\\.tw-login-btn\\s*\\{[^}]*background: ' + BRAND + ';', 's'));
});

test('focus stays a bright frame, distinct from the brand accent', () => {
  assert.match(CSS, /\.tw-grid-frame\s*\{[^}]*outline: 4px solid #f4f4f7;/s);
  assert.match(CSS, /\.tw-control\.tw-focused\s*\{[^}]*background: #f4f4f7;/s);
  assert.match(CSS, /\.tw-account\.tw-focused\s*\{[^}]*background: #f4f4f7;/s);
});

test('surfaces are rounded instead of uniformly square', () => {
  assert.match(CSS, /\.tw-thumb\s*\{[^}]*border-radius: 8px;/s);
  assert.match(CSS, /\.tw-panel\s*\{[^}]*border-radius: 12px;/s);
  assert.match(CSS, /\.tw-account\s*\{[^}]*border-radius: 18px;/s);
});

test('measured layout geometry is unchanged by the skin', () => {
  assert.match(CSS, /\.tw-grid-wrap\s*\{[^}]*top: 114px;/s);
  assert.match(CSS, /\.tw-thumb\s*\{[^}]*height: 167\.15625px;/s);
  assert.match(CSS, /\.tw-cell\s*\{[^}]*width: 25%;[^}]*padding: 6px 5px 13px;/s);
  assert.match(CSS, /\.tw-chat\s*\{[^}]*width: 360px;[^}]*height: 720px;/s);
});

test('stylesheet stays within old-WebKit limits (no flex/grid/vw/custom properties)', () => {
  assert.doesNotMatch(CSS, /display\s*:\s*(flex|grid|inline-flex|inline-grid)\b/);
  assert.doesNotMatch(CSS, /\b\d*\.?\d+(vw|vh|vmin|vmax)\b/);
  assert.doesNotMatch(CSS, /var\(--/);
  assert.doesNotMatch(CSS, /backdrop-filter/);
});
