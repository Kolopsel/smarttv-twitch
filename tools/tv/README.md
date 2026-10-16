# TV harness — Samsung Tizen developer control from this PC

`tv-harness.js` is a dependency-free Node CLI that reaches the highest
access level Samsung's documented developer interface offers:

| Channel | Needs | Gives |
| --- | --- | --- |
| Samsung REST API (`:8001`) | TV on, same LAN | Model, DUID, Developer Mode state, per-app status |
| SSDP discovery | Multicast-friendly LAN | Find Samsung TVs without knowing the IP |
| SDB (`:26101`) | Tizen Studio tools + paired Host PC IP | Developer shell, app list/launch/stop, install/uninstall, push/pull, `dlog`, debug launch + DevTools forwarding |
| Tizen CLI | Tizen Studio tools | Package/sign widgets (used indirectly; see below) |

There is **no root shell** behind Developer Mode. The SDB shell runs as
the unprivileged `developer` user, system partitions stay read-only, and
`install` only accepts packages signed for this TV (a Samsung
certificate whose distributor profile lists this TV's DUID). Anything
beyond that would need a firmware exploit, which this harness does not
attempt.

## Quick start

```powershell
# One-time: Samsung's official CLI tools (sdb + tizen), unattended
node tools/tv/tv-harness.js setup-sdk --yes

# See where you stand (read-only, safe any time)
node tools/tv/tv-harness.js doctor

# Point the harness at your TV once (gitignored local config)
#   tools/tv/tv.local.json   ->   { "tvIp": "192.168.1.26" }
# or pass --tv <ip> / set SAMSUNG_TV_IP on every call.
```

## Pairing SDB (one TV-side step)

Samsung's SDB daemon only accepts connections from the single Host PC
IP stored in Developer Mode. Our TV currently stores `127.0.0.1`,
which is TizenBrew's self-debug setup, so PC connections are refused
even though port 26101 is open. `doctor` prints these steps with your
real addresses filled in:

1. On the TV: **Apps**, enter **12345**, set Developer Mode **ON** and
   Host PC IP to this PC's LAN address. Choose OK.
2. Reboot the TV properly (hold Power until the Samsung logo, or
   unplug for 60 seconds) — a short press is standby and changes nothing.
3. Run `node tools/tv/tv-harness.js connect` and accept the
   authorization prompt on the TV (first connection only; the RSA key
   is then stored under your Windows profile by `sdb`).
4. When finished debugging, set Host PC IP back to `127.0.0.1` and
   reboot again so TizenBrew's own loopback debug behaviour is restored.

## Commands

```text
Flags: --tv <ip>  --serial <id>  --sdk <tizen-studio root>
       --yes (confirm destructive ops)  --dry-run  --json

Read-only:  discover | info | ports | app-status <appId> |
            brew-status | doctor
SDB:        connect | devices | shell -- <cmd...> | apps |
            launch <appId> | stop-app <appId> |
            install <file.wgt> | uninstall <pkgId> --yes |
            push <local> <remote> | pull <remote> <local> |
            dlog [filter...] | debug <appId> [localPort] |
            forward <localPort> <remotePort>
Setup:      setup-sdk [--yes]
```

Examples:

```powershell
node tools/tv/tv-harness.js doctor
node tools/tv/tv-harness.js shell -- pkgcmd -l
node tools/tv/tv-harness.js dlog
node tools/tv/tv-harness.js debug xvvl3S1bvH.TizenBrewStandalone
node tools/tv/tv-harness.js --dry-run install .\Twellie.wgt
```

`debug` launches the app under the TV's inspector and forwards the
port, then prints the local URL to attach Chrome DevTools
(`chrome://inspect`). That is the fastest way to see Twellie's console
and network errors on real hardware.

## Persistent access with Host PC IP left at 127.0.0.1 (relay mode)

Twellie's TizenBrew module ships a `serviceFile` relay that runs in
TizenBrew's Node service on the TV. It forwards LAN TCP connections on
port **47995** to the TV's own SDB daemon at `127.0.0.1:26101`, so the
daemon sees the loopback host it already trusts while this PC keeps
full SDB access — no Developer Mode IP change, and TizenBrew keeps
working exactly as before. Only private-LAN source addresses are
accepted, and SDB's RSA authorization still applies end to end.

```powershell
node tools/tv/tv-harness.js --relay connect
node tools/tv/tv-harness.js --relay shell -- pkgcmd -l
node tools/tv/tv-harness.js --relay dlog
```

For access while Twellie is closed, enable the module service's
auto-launch in TizenBrew's Module Manager; otherwise the relay runs
whenever Twellie has been launched. `doctor` probes port 47995 and
points at relay mode when it answers. The same service also relays
Twellie's HLS playback on loopback port 47994 (see
`src/platforms/tizenbrew/proxy-service.js`).

## Safety rails

- `uninstall` refuses to run without `--yes`.
- `--dry-run` prints every `sdb` invocation instead of executing it.
- App/package ids are validated before reaching a shell command.
- The harness never changes Developer Mode or Host PC IP itself;
  that switch intentionally stays a physical, on-TV action.

## Signing note for `install`

`sdb install` only lands packages signed for this TV. Producing one
means a Samsung author + distributor certificate pair for the TV's
DUID (`doctor` prints it), created once in Tizen Studio's Certificate
Manager with a Samsung account, then `tizen package -t wgt -s
<profile>`. TizenBrew modules (like Twellie) do not need this — they
install from GitHub through TizenBrew itself.
