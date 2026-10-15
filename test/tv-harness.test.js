'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  quoteWin, parseArgs, parseDevices, parseDebugPort, parseSsdp,
  candidateSdkRoots, resolveTool, pairingSteps, TIZENBREW_APP_ID,
} = require('../tools/tv/tv-harness');

const CLI = path.resolve(__dirname, '..', 'tools/tv/tv-harness.js');

test('parseArgs separates leading flags from the command and its args', () => {
  const parsed = parseArgs(['--tv=192.168.1.26', '--yes', '--dry-run', 'uninstall', 'pkg.id']);
  assert.equal(parsed.flags.tvIp, '192.168.1.26');
  assert.equal(parsed.flags.yes, true);
  assert.equal(parsed.flags.dryRun, true);
  assert.equal(parsed.command, 'uninstall');
  assert.deepEqual(parsed.args, ['pkg.id']);

  const shell = parseArgs(['--tv', '10.0.0.2', 'shell', '--', 'pkgcmd', '-l']);
  assert.equal(shell.flags.tvIp, '10.0.0.2');
  assert.equal(shell.command, 'shell');
  assert.deepEqual(shell.args, ['--', 'pkgcmd', '-l']);
});

test('parseDevices reads sdb device rows and skips banners', () => {
  const text = '* Server has started successfully *\n' +
    'List of devices attached \n' +
    '192.168.1.26:26101  device    TQ55Q80DATXXC\n' +
    'emulator-26101      offline\n';
  assert.deepEqual(parseDevices(text), [
    { serial: '192.168.1.26:26101', state: 'device', detail: 'TQ55Q80DATXXC' },
    { serial: 'emulator-26101', state: 'offline', detail: '' },
  ]);
  assert.deepEqual(parseDevices('List of devices attached \n'), []);
});

test('parseDebugPort finds labelled and bare ports', () => {
  assert.equal(parseDebugPort('... successfully launched. port: 54321'), 54321);
  assert.equal(parseDebugPort('debugger listening on :9229'), 9229);
  assert.equal(parseDebugPort('no port here'), null);
});

test('parseSsdp normalises header names', () => {
  const h = parseSsdp('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.26:9197/dmr\r\nSERVER: Samsung\r\n\r\n');
  assert.equal(h.location, 'http://192.168.1.26:9197/dmr');
  assert.equal(h.server, 'Samsung');
});

test('resolveTool prefers env override, then SDK roots', () => {
  const envHit = resolveTool('sdb', { SDB_PATH: 'X:/custom/sdb.exe' }, null, () => true);
  assert.deepEqual(envHit, { path: 'X:/custom/sdb.exe', source: 'env' });

  const rootHit = resolveTool('sdb', {}, 'D:/sdk', (p) => p.replace(/\\/g, '/') === 'D:/sdk/tools/sdb.exe' && process.platform === 'win32' || p.endsWith('tools/sdb'));
  assert.ok(rootHit && rootHit.source === 'D:/sdk');

  assert.equal(resolveTool('tizen', {}, 'D:/nowhere', () => false), null);
  assert.ok(candidateSdkRoots({}, 'D:/sdk')[0] === 'D:/sdk');
});

test('quoteWin only quotes when needed', () => {
  assert.equal(quoteWin('plain'), 'plain');
  assert.equal(quoteWin('a b'), '"a b"');
  assert.equal(quoteWin('a"b'), '"a\\"b"');
});

test('pairing steps name the PC IP and the TizenBrew revert step', () => {
  const text = pairingSteps({
    pcIps: ['192.168.1.240'], tvIp: '192.168.1.26',
    tv: { developerIP: '127.0.0.1' },
  });
  assert.match(text, /192\.168\.1\.240/);
  assert.match(text, /back to 127\.0\.0\.1/);
  assert.match(text, /no root shell/);
});

test('CLI help lists doctor and exits 0', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /doctor/);
  assert.match(r.stdout, /uninstall <pkgId> --yes/);
});

test('CLI refuses destructive uninstall without --yes before touching the TV', () => {
  const r = spawnSync(process.execPath, [CLI, '--tv', '192.0.2.10', 'uninstall', 'some.pkg'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /re-run with --yes/);
});

test('TizenBrew app id matches the standalone widget id', () => {
  assert.equal(TIZENBREW_APP_ID, 'xvvl3S1bvH.TizenBrewStandalone');
});
