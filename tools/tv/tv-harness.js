#!/usr/bin/env node
/*
 * tools/tv/tv-harness.js — Samsung Tizen TV developer harness.
 *
 * One CLI over the three legitimate access channels a Samsung TV offers:
 *   1. Samsung REST API  http://<tv>:8001/api/v2/   (no pairing, read-only)
 *   2. SDB               <tv>:26101                  (developer shell: apps,
 *      install/uninstall, files, dlog, debug launch + port forwarding)
 *   3. Tizen CLI                                     (package/sign/install)
 *
 * SDB/Tizen come from Samsung's Tizen Studio. Run `node tools/tv/tv-harness.js
 * doctor` for a full picture of what is installed, what the TV allows, and
 * the exact pairing steps still missing. There is no root shell behind the
 * developer interface: the SDB shell runs as the unprivileged developer
 * user, and that documented ceiling is what this harness reaches.
 *
 * No dependencies. Windows-first (this project's TV is driven from Windows),
 * with POSIX paths handled where free.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawnSync } = require('child_process');

const SDB_PORT = 26101;
const RELAY_PORT = 47995;
const REST_PORT = 8001;
const TIZENBREW_APP_ID = 'xvvl3S1bvH.TizenBrewStandalone';
const SDK_INSTALLER_URL =
  'https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_windows-64.exe';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function die(message, code) {
  console.error('tv-harness: ' + message);
  process.exit(code == null ? 1 : code);
}

function quoteWin(arg) {
  const s = String(arg);
  if (!/[\s"&|<>^%]/.test(s)) { return s; }
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// Run a file with an argv array. .bat/.cmd shims (tizen.bat) need a shell on
// Windows; real executables are spawned directly. Returns the spawnSync
// result; with capture:true stdout/stderr are strings on the result.
function runFile(file, args, opts) {
  const options = opts || {};
  const spawnOpts = {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeoutMs || 0,
  };
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(file)) {
    const cmdline = [quoteWin(file)].concat((args || []).map(quoteWin)).join(' ');
    return spawnSync(cmdline, [], Object.assign({}, spawnOpts, { shell: true }));
  }
  return spawnSync(file, args || [], spawnOpts);
}

function localIpv4Addresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) { out.push(info.address); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool discovery (sdb / tizen)
// ---------------------------------------------------------------------------

function candidateSdkRoots(env, sdkFlag) {
  const roots = [];
  const push = (p) => { if (p && roots.indexOf(p) === -1) { roots.push(p); } };
  push(sdkFlag);
  push(env.TIZEN_STUDIO_HOME);
  push(env.TIZEN_SDK_HOME);
  if (process.platform === 'win32') {
    push('C:\\tizen-studio');
    push('C:\\TizenStudio');
    push(path.join(os.homedir(), 'tizen-studio'));
  } else {
    push(path.join(os.homedir(), 'tizen-studio'));
    push('/opt/tizen-studio');
  }
  return roots;
}

function toolRelPaths(name) {
  if (process.platform === 'win32') {
    return name === 'sdb'
      ? [path.join('tools', 'sdb.exe')]
      : [path.join('tools', 'ide', 'bin', 'tizen.bat'), path.join('tools', 'ide', 'bin', 'tizen.exe')];
  }
  return name === 'sdb'
    ? [path.join('tools', 'sdb')]
    : [path.join('tools', 'ide', 'bin', 'tizen')];
}

// Resolve one tool: explicit env override, then SDK roots, then PATH name.
// `exists` is injectable for tests. Returns { path, source } or null.
function resolveTool(name, env, sdkFlag, exists) {
  const fileExists = exists || fs.existsSync;
  const override = name === 'sdb' ? env.SDB_PATH : env.TIZEN_PATH;
  if (override) {
    return fileExists(override) ? { path: override, source: 'env' } : { path: override, source: 'env-missing' };
  }
  for (const root of candidateSdkRoots(env, sdkFlag)) {
    for (const rel of toolRelPaths(name)) {
      const candidate = path.join(root, rel);
      if (fileExists(candidate)) { return { path: candidate, source: root }; }
    }
  }
  return null; // caller may fall back to the bare name on PATH
}

function resolveTools(env, sdkFlag) {
  const sdb = resolveTool('sdb', env, sdkFlag) || { path: 'sdb', source: 'PATH (unverified)' };
  const tizen = resolveTool('tizen', env, sdkFlag) || { path: 'tizen', source: 'PATH (unverified)' };
  return { sdb, tizen };
}

function toolVersion(tool) {
  try {
    const r = runFile(tool.path, ['version'], { capture: true, timeoutMs: 8000 });
    if (r && !r.error && (r.stdout || r.stderr)) {
      return String(r.stdout || r.stderr).trim().split(/\r?\n/)[0];
    }
  } catch (e) { /* reported as missing below */ }
  return null;
}

// ---------------------------------------------------------------------------
// Samsung REST API (port 8001, no pairing needed for these reads)
// ---------------------------------------------------------------------------

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 6000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(text), text }); }
        catch (e) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
  });
}

async function tvInfo(ip) {
  const r = await httpGetJson('http://' + ip + ':' + REST_PORT + '/api/v2/');
  if (r.status !== 200 || !r.json || !r.json.device) {
    throw new Error('Samsung API at ' + ip + ':' + REST_PORT + ' returned HTTP ' + r.status);
  }
  return r.json;
}

async function appStatus(ip, appId) {
  const r = await httpGetJson(
    'http://' + ip + ':' + REST_PORT + '/api/v2/applications/' + encodeURIComponent(appId));
  return { status: r.status, app: r.json };
}

function probePort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) { return; }
      done = true;
      try { socket.destroy(); } catch (e) {}
      resolve({ port, open });
    };
    socket.setTimeout(timeoutMs || 2500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

// ---------------------------------------------------------------------------
// SSDP discovery (find Samsung TVs without a hardcoded IP)
// ---------------------------------------------------------------------------

function parseSsdp(text) {
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) { headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim(); }
  }
  return headers;
}

function discoverTvs(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const searchTargets = [
      'urn:samsung.com:service:RemoteControlReceiver:1',
      'urn:samsung.com:device:RemoteControlReceiver:1',
      'ssdp:all',
    ];
    const searches = searchTargets.map((st) => Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 3',
      'ST: ' + st,
      '', '',
    ].join('\r\n')));
    const timer = setTimeout(() => {
      try { socket.close(); } catch (e) {}
      resolve(Array.from(found.values()));
    }, timeoutMs || 4000);
    socket.on('message', (msg, rinfo) => {
      const h = parseSsdp(msg.toString('utf8'));
      if (!found.has(rinfo.address)) {
        found.set(rinfo.address, { ip: rinfo.address, location: h.location || null, server: h.server || null });
      }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(Array.from(found.values())); });
    socket.bind(() => {
      try { socket.setMulticastTTL(4); } catch (e) {}
      for (const search of searches) { socket.send(search, 1900, '239.255.255.250'); }
    });
  });
}

// ---------------------------------------------------------------------------
// SDB layer
// ---------------------------------------------------------------------------

function parseDevices(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^list of devices/i.test(t) || t.charAt(0) === '*') { continue; }
    const parts = t.split(/\s+/);
    if (parts.length >= 2) { out.push({ serial: parts[0], state: parts[1], detail: parts.slice(2).join(' ') }); }
  }
  return out;
}

function parseDebugPort(text) {
  const s = String(text || '');
  const labelled = s.match(/port\D{0,12}(\d{3,5})/i);
  if (labelled) { return Number(labelled[1]); }
  const nums = s.match(/\b\d{4,5}\b/g);
  return nums && nums.length ? Number(nums[nums.length - 1]) : null;
}

function makeSdb(ctx) {
  const exe = ctx.tools.sdb.path;
  function run(args, opts) {
    const options = opts || {};
    if (ctx.dryRun) {
      console.log('DRY-RUN: sdb ' + args.join(' '));
      return { status: 0, stdout: '', stderr: '' };
    }
    const r = runFile(exe, args, { capture: !!options.capture, timeoutMs: options.timeoutMs || 0 });
    if (r && r.error && r.error.code === 'ENOENT') {
      die('sdb not found (' + exe + '). Run `node tools/tv/tv-harness.js setup-sdk` or install Tizen Studio.');
    }
    return r;
  }
  function devices() {
    const r = run(['devices'], { capture: true, timeoutMs: 15000 });
    return parseDevices((r && r.stdout) || '');
  }
  function ensureSerial() {
    if (ctx.serial) { return ctx.serial; }
    const wanted = ctx.tvIp + ':' + (ctx.relay ? RELAY_PORT : SDB_PORT);
    let list = devices();
    let match = list.find((d) => d.serial === wanted);
    if (!match || match.state !== 'device') {
      console.log('Connecting to ' + wanted + ' ... (accept the authorization prompt on the TV if shown)');
      run(['connect', wanted], {});
      list = devices();
      match = list.find((d) => d.serial === wanted) || list.find((d) => d.state === 'device');
    }
    if (match && match.state === 'unauthorized') {
      die('TV reports this PC as unauthorized. Accept the RSA prompt on the TV screen, then retry.');
    }
    if (!match || match.state !== 'device') {
      if (ctx.relay) {
        die('No SDB device via the Twellie relay at ' + wanted + '. Is the updated ' +
          'Twellie module installed and its service running (launch Twellie once, or ' +
          'enable its service auto-launch in TizenBrew)? If the TV shows an ' +
          'authorization prompt, accept it and retry.');
      }
      die('No authorized SDB device. On the TV: Apps panel, enter 12345, set Developer ' +
        'Mode ON and Host PC IP to this PC (' + localIpv4Addresses().join(', ') +
        '), reboot the TV, then run `doctor` again. ' +
        'Remember to set Host PC IP back to 127.0.0.1 afterwards for TizenBrew.');
    }
    ctx.serial = match.serial;
    return ctx.serial;
  }
  function shell(args, opts) {
    const serial = ensureSerial();
    return run(['-s', serial, 'shell'].concat(args), opts || {});
  }
  return { run, devices, ensureSerial, shell };
}

function checkStatus(result, what) {
  if (!result || result.status !== 0) {
    die(what + ' failed' + (result && result.stderr ? ': ' + String(result.stderr).trim() : '') +
      ' (exit ' + (result ? result.status : 'unknown') + ')');
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'tv.local.json'), 'utf8'));
  } catch (e) { return {}; }
}

function parseArgs(argv) {
  const flags = { tvIp: null, serial: null, sdk: null, yes: false, dryRun: false, json: false, relay: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '--yes') { flags.yes = true; i++; continue; }
    if (a === '--dry-run') { flags.dryRun = true; i++; continue; }
    if (a === '--json') { flags.json = true; i++; continue; }
    if (a === '--relay') { flags.relay = true; i++; continue; }
    const m = a.match(/^--(tv|serial|sdk)(?:=(.*))?$/);
    if (m) {
      const value = m[2] != null ? m[2] : argv[i + 1];
      if (value == null) { die('flag --' + m[1] + ' needs a value'); }
      if (m[1] === 'tv') { flags.tvIp = value; }
      if (m[1] === 'serial') { flags.serial = value; }
      if (m[1] === 'sdk') { flags.sdk = value; }
      i += m[2] != null ? 1 : 2;
      continue;
    }
    break;
  }
  return { flags, command: argv[i] || null, args: argv.slice(i + 1) };
}

async function resolveTvIp(flags) {
  if (flags.tvIp) { return flags.tvIp; }
  if (process.env.SAMSUNG_TV_IP) { return process.env.SAMSUNG_TV_IP; }
  const local = readLocalConfig();
  if (local.tvIp) { return local.tvIp; }
  console.log('No --tv given; discovering Samsung TVs on the LAN (SSDP)...');
  const found = await discoverTvs(4000);
  if (found.length === 1) { return found[0].ip; }
  if (found.length > 1) {
    die('Found several TVs (' + found.map((f) => f.ip).join(', ') + '). Re-run with --tv <ip>.');
  }
  die('No Samsung TV discovered. Pass --tv <ip>, set SAMSUNG_TV_IP, or add tools/tv/tv.local.json.');
  return null;
}

function printJson(value) { console.log(JSON.stringify(value, null, 2)); }

async function collectDoctor(ctx) {
  const pcIps = localIpv4Addresses();
  const sdbVersion = toolVersion(ctx.tools.sdb);
  const tizenVersion = toolVersion(ctx.tools.tizen);
  let info = null;
  let infoError = null;
  try { info = await tvInfo(ctx.tvIp); } catch (e) { infoError = e.message; }
  const ports = {};
  for (const p of [SDB_PORT, REST_PORT, 8002, RELAY_PORT]) {
    ports[p] = (await probePort(ctx.tvIp, p)).open;
  }
  let devicesList = [];
  if (sdbVersion) {
    try { devicesList = makeSdb(ctx).devices(); } catch (e) { devicesList = []; }
  }
  const device = info && info.device ? info.device : null;
  const pairedHostOk = !!(device && pcIps.indexOf(device.developerIP) !== -1);
  const wanted = ctx.tvIp + ':' + SDB_PORT;
  const sdbReady = devicesList.some((d) => d.serial === wanted && d.state === 'device');
  return {
    tvIp: ctx.tvIp,
    pcIps,
    tools: {
      sdb: { path: ctx.tools.sdb.path, source: ctx.tools.sdb.source, version: sdbVersion },
      tizen: { path: ctx.tools.tizen.path, source: ctx.tools.tizen.source, version: tizenVersion },
    },
    tv: device ? {
      name: info.name, modelName: device.modelName, model: device.model,
      powerState: device.PowerState, developerMode: device.developerMode,
      developerIP: device.developerIP, duid: device.duid, resolution: device.resolution,
    } : null,
    tvError: infoError,
    ports,
    sdbDevices: devicesList,
    pairedHostOk,
    sdbReady,
    relayReady: !!ports[RELAY_PORT],
  };
}

function pairingSteps(report) {
  const pc = report.pcIps[0] || '<this PC IP>';
  return [
    'On the TV remote:',
    '  1. Open Apps, then enter 12345 to open Developer Mode settings.',
    '  2. Developer Mode: ON. Host PC IP: ' + pc + ' (currently ' +
      (report.tv ? report.tv.developerIP : 'unknown') + '). Choose OK.',
    '  3. Reboot the TV (hold Power until the Samsung logo, or unplug 60 s).',
    '  4. Run: node tools/tv/tv-harness.js --tv ' + report.tvIp + ' connect',
    '     and accept the authorization prompt on the TV screen.',
    '  5. When done debugging, set Host PC IP back to 127.0.0.1 and reboot,',
    '     which restores TizenBrew\'s own loopback debug behaviour.',
    'Access ceiling: SDB shell runs as the unprivileged developer user.',
    'Samsung exposes no root shell through Developer Mode; install still',
    'requires packages signed for this TV (Samsung certificate + DUID).',
  ].join('\n');
}

const USAGE = [
  'Usage: node tools/tv/tv-harness.js [flags] <command> [args]',
  '',
  'Flags: --tv <ip>  --serial <id>  --sdk <tizen-studio root>',
  '       --yes (confirm destructive ops)  --dry-run  --json',
  '       --relay (SDB via the Twellie TV relay on port 47995; keeps',
  '       working while the TV Host PC IP stays 127.0.0.1)',
  '',
  'Read-only (no pairing needed):',
  '  discover                 Find Samsung TVs on the LAN (SSDP)',
  '  info                     TV model, Developer Mode, DUID, power state',
  '  ports                    Probe SDB/REST/remote ports',
  '  app-status <appId>       Installed/running state of one Samsung app',
  '  brew-status              TizenBrew app status via the Samsung API',
  '  doctor                   Full diagnosis + exact pairing steps',
  '',
  'SDB (needs paired Developer Mode host, see doctor):',
  '  connect                  sdb connect + list devices',
  '  devices                  sdb devices',
  '  shell -- <cmd...>        Run a command in the TV developer shell',
  '  apps                     List installed packages (pkgcmd -l)',
  '  launch <appId>           Start an app    stop-app <appId>  Stop it',
  '  install <file.wgt>       Install a signed widget package',
  '  uninstall <pkgId> --yes  Remove a package (destructive)',
  '  push <local> <remote>    Copy a file to the TV',
  '  pull <remote> <local>    Copy a file from the TV',
  '  dlog [filter...]         Stream device logs (Ctrl+C to stop)',
  '  debug <appId> [port]     Launch in debug mode + forward DevTools port',
  '  forward <lport> <rport>  sdb forward tcp:<lport> tcp:<rport>',
  '',
  'Setup:',
  '  setup-sdk [--yes]        Show or perform the Tizen Studio CLI install',
].join('\n');

function downloadFile(url, dest, redirectsLeft) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirectsLeft || 0) <= 0) { reject(new Error('too many redirects')); return; }
        resolve(downloadFile(new URL(res.headers.location, url).href, dest, (redirectsLeft || 0) - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('download returned HTTP ' + res.statusCode));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function setupSdk(ctx) {
  const root = ctx.sdkRoot || (process.platform === 'win32' ? 'C:\\tizen-studio' : path.join(os.homedir(), 'tizen-studio'));
  const already = resolveTool('sdb', process.env, root);
  if (already && fs.existsSync(already.path)) {
    console.log('sdb already present: ' + already.path + ' (' + (toolVersion(already) || 'version unknown') + ')');
    return;
  }
  if (process.platform !== 'win32') {
    die('Automatic SDK setup is Windows-only here. Install Tizen Studio CLI from ' + SDK_INSTALLER_URL);
  }
  if (!ctx.yes) {
    console.log('Would download Samsung\'s official Tizen Studio CLI installer:');
    console.log('  ' + SDK_INSTALLER_URL);
    console.log('and run it unattended into ' + root + ' (`--accept-license`).');
    console.log('Re-run with --yes to do it.');
    return;
  }
  const dest = path.join(os.tmpdir(), 'web-cli_Tizen_Studio.exe');
  console.log('Downloading ' + SDK_INSTALLER_URL + ' ...');
  await downloadFile(SDK_INSTALLER_URL, dest, 5);
  console.log('Installing into ' + root + ' (this can take several minutes)...');
  const r = runFile(dest, ['--accept-license', root], {});
  checkStatus(r, 'Tizen Studio CLI install');
  const sdb = resolveTool('sdb', process.env, root);
  if (!sdb || !fs.existsSync(sdb.path)) { die('Install finished but sdb was not found under ' + root); }
  console.log('Installed: ' + sdb.path + ' (' + (toolVersion(sdb) || 'version unknown') + ')');
}

function assertSafeId(id, what) {
  if (!/^[\w.\-]+$/.test(id || '')) { die('invalid ' + what + ': ' + id); }
  return id;
}

async function main() {
  const { flags, command, args } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }
  const tools = resolveTools(process.env, flags.sdk);
  const ctx = {
    tvIp: null, serial: flags.serial, sdkRoot: flags.sdk,
    tools, dryRun: flags.dryRun, yes: flags.yes, json: flags.json, relay: flags.relay,
  };

  if (command === 'discover') {
    const found = await discoverTvs(5000);
    if (ctx.json) { printJson(found); return; }
    if (!found.length) { console.log('No Samsung TVs answered SSDP discovery.'); return; }
    for (const tv of found) { console.log(tv.ip + (tv.location ? '  ' + tv.location : '')); }
    return;
  }
  if (command === 'setup-sdk') { await setupSdk(ctx); return; }

  ctx.tvIp = await resolveTvIp(flags);
  const sdb = makeSdb(ctx);

  switch (command) {
    case 'info': {
      const info = await tvInfo(ctx.tvIp);
      if (ctx.json) { printJson(info); break; }
      const d = info.device;
      console.log('Name:           ' + String(info.name || '').replace(/&quot;/g, '"'));
      console.log('Model:          ' + d.modelName + ' (' + d.model + ')');
      console.log('IP / power:     ' + d.ip + ' / ' + d.PowerState);
      console.log('Resolution:     ' + d.resolution);
      console.log('DUID:           ' + d.duid);
      console.log('Developer mode: ' + d.developerMode + ' (Host PC IP ' + d.developerIP + ')');
      break;
    }
    case 'ports': {
      const rows = [];
      for (const p of [SDB_PORT, REST_PORT, 8002]) { rows.push(await probePort(ctx.tvIp, p)); }
      if (ctx.json) { printJson(rows); break; }
      for (const r of rows) { console.log(ctx.tvIp + ':' + r.port + ' ' + (r.open ? 'open' : 'closed')); }
      break;
    }
    case 'app-status': {
      if (!args[0]) { die('app-status needs an application id'); }
      const r = await appStatus(ctx.tvIp, args[0]);
      if (ctx.json) { printJson(r); break; }
      console.log(r.status === 200 && r.app
        ? r.app.id + ' "' + r.app.name + '" v' + r.app.version +
          ' running=' + r.app.running + ' visible=' + r.app.visible
        : 'Not installed (HTTP ' + r.status + '): ' + args[0]);
      break;
    }
    case 'brew-status': {
      const r = await appStatus(ctx.tvIp, TIZENBREW_APP_ID);
      if (ctx.json) { printJson(r); break; }
      console.log(r.status === 200 && r.app
        ? 'TizenBrew ' + r.app.version + ' installed, running=' + r.app.running
        : 'TizenBrew not installed (HTTP ' + r.status + ')');
      break;
    }
    case 'doctor': {
      const report = await collectDoctor(ctx);
      if (ctx.json) { printJson(report); break; }
      console.log('PC addresses:   ' + (report.pcIps.join(', ') || '(none)'));
      console.log('sdb:            ' + (report.tools.sdb.version || 'NOT FOUND') + '  [' + report.tools.sdb.path + ']');
      console.log('tizen:          ' + (report.tools.tizen.version || 'not verified') + '  [' + report.tools.tizen.path + ']');
      if (report.tv) {
        console.log('TV:             ' + report.tv.modelName + ' power=' + report.tv.powerState +
          ' developerMode=' + report.tv.developerMode + ' developerIP=' + report.tv.developerIP);
        console.log('DUID:           ' + report.tv.duid);
      } else {
        console.log('TV:             unreachable via Samsung API (' + report.tvError + ')');
      }
      console.log('Ports:          ' + Object.keys(report.ports).map((p) => p + '=' + (report.ports[p] ? 'open' : 'closed')).join('  '));
      console.log('SDB devices:    ' + (report.sdbDevices.length
        ? report.sdbDevices.map((d) => d.serial + ' ' + d.state).join(', ') : '(none)'));
      console.log('');
      if (report.sdbReady) {
        console.log('SDB is paired and ready: shell, apps, install, uninstall, push/pull, dlog and debug are available.');
      } else if (report.relayReady) {
        console.log('Twellie SDB relay is reachable on port ' + RELAY_PORT +
          ': run `node tools/tv/tv-harness.js --relay connect` for shell/apps/logs/debug');
        console.log('without changing the TV Host PC IP away from 127.0.0.1.');
      } else if (!report.tools.sdb.version) {
        console.log('Next step: install the tools with `node tools/tv/tv-harness.js setup-sdk --yes`, then pair:');
        console.log(pairingSteps(report));
      } else {
        console.log(pairingSteps(report));
      }
      break;
    }
    case 'connect': {
      const serial = sdb.ensureSerial();
      console.log('Connected: ' + serial);
      for (const d of sdb.devices()) { console.log(d.serial + ' ' + d.state + ' ' + d.detail); }
      break;
    }
    case 'devices': {
      const list = sdb.devices();
      if (ctx.json) { printJson(list); break; }
      if (!list.length) { console.log('No SDB devices.'); }
      for (const d of list) { console.log(d.serial + ' ' + d.state + ' ' + d.detail); }
      break;
    }
    case 'shell': {
      const cmdArgs = args[0] === '--' ? args.slice(1) : args;
      if (!cmdArgs.length) { die('shell needs a command, e.g. shell -- pkgcmd -l'); }
      const r = sdb.shell(cmdArgs, {});
      process.exit(r && r.status != null ? r.status : 1);
      break;
    }
    case 'apps': {
      const r = sdb.shell(['pkgcmd -l'], { capture: true, timeoutMs: 30000 });
      process.stdout.write((r && r.stdout) || '');
      if (!r || r.status !== 0) {
        console.log('pkgcmd -l failed; try `shell -- app_launcher -l` on this firmware.');
      }
      break;
    }
    case 'launch': {
      const id = assertSafeId(args[0], 'app id');
      checkStatus(sdb.shell(['app_launcher -s ' + id], {}), 'launch');
      break;
    }
    case 'stop-app': {
      const id = assertSafeId(args[0], 'app id');
      checkStatus(sdb.shell(['app_launcher -k ' + id], {}), 'stop-app');
      break;
    }
    case 'install': {
      const file = args[0];
      if (!file || !fs.existsSync(file)) { die('install needs an existing .wgt/.tpk file'); }
      const serial = sdb.ensureSerial();
      checkStatus(sdb.run(['-s', serial, 'install', file], {}), 'install');
      break;
    }
    case 'uninstall': {
      const id = assertSafeId(args[0], 'package id');
      if (!ctx.yes) { die('uninstall is destructive; re-run with --yes to remove ' + id); }
      const serial = sdb.ensureSerial();
      checkStatus(sdb.run(['-s', serial, 'uninstall', id], {}), 'uninstall');
      break;
    }
    case 'push':
    case 'pull': {
      if (args.length < 2) { die(command + ' needs <from> <to>'); }
      const serial = sdb.ensureSerial();
      checkStatus(sdb.run(['-s', serial, command, args[0], args[1]], {}), command);
      break;
    }
    case 'dlog': {
      const serial = sdb.ensureSerial();
      const r = sdb.run(['-s', serial, 'dlog'].concat(args), {});
      process.exit(r && r.status != null ? r.status : 1);
      break;
    }
    case 'forward': {
      if (args.length < 2) { die('forward needs <localPort> <remotePort>'); }
      const serial = sdb.ensureSerial();
      checkStatus(sdb.run(['-s', serial, 'forward', 'tcp:' + args[0], 'tcp:' + args[1]], {}), 'forward');
      console.log('Forwarding localhost:' + args[0] + ' -> TV:' + args[1]);
      break;
    }
    case 'debug': {
      const id = assertSafeId(args[0], 'app id');
      const localPort = Number(args[1] || 9229);
      const serial = sdb.ensureSerial();
      const r = sdb.shell(['debug ' + id], { capture: true, timeoutMs: 30000 });
      const out = ((r && r.stdout) || '') + '\n' + ((r && r.stderr) || '');
      process.stdout.write((r && r.stdout) || '');
      const remotePort = parseDebugPort(out);
      if (!remotePort) { die('Could not find a debug port in the TV response. Output was:\n' + out.trim()); }
      checkStatus(sdb.run(['-s', serial, 'forward', 'tcp:' + localPort, 'tcp:' + remotePort], {}), 'forward');
      console.log('Debug port forwarded: TV ' + remotePort + ' -> http://localhost:' + localPort);
      console.log('Open chrome://inspect (or that URL) in Chrome on this PC to attach DevTools.');
      break;
    }
    default:
      console.error(USAGE);
      die('unknown command: ' + command);
  }
}

if (require.main === module) {
  main().catch((e) => die(e && e.message ? e.message : String(e)));
}

module.exports = {
  SDB_PORT, RELAY_PORT, REST_PORT, TIZENBREW_APP_ID, SDK_INSTALLER_URL,
  quoteWin, parseArgs, parseDevices, parseDebugPort, parseSsdp,
  candidateSdkRoots, resolveTool, pairingSteps,
};





