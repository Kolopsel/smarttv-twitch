# Install this fork (Midnight skin) with TizenBrew

This fork is Twellie 4.1.0 with a redesigned TV interface: near-black
`#0e0e10` rooms, soft-cornered thumbnails and panels, Twitch purple
(`#9146ff`) for the active tab, playback progress, login and account
actions, and the same bright-white remote focus frame as upstream.
No layout geometry or TV behaviour changed; `test/skin.test.js` pins
that contract.

## Why a GitHub step is needed

TizenBrew does not load app modules from your PC or a USB stick. It
fetches them through the jsDelivr CDN from a GitHub repository
(`gh/<user>/<repo>`), and the unversioned CDN URL resolves to the
repository's **latest GitHub Release**. So this fork has to exist
under your GitHub account, with a release, before the TV can see it.

## 1. Publish the fork (one time, about 5 minutes)

1. On <https://github.com/nkatchik/smarttv-twitch>, click **Fork**
   and keep the repository name `smarttv-twitch`.
2. In this folder (`twitch-tv-tizen`), publish with the helper
   script. It checks your fork, asks for your Git identity if unset,
   commits the skin files by name, and pushes (GitHub opens a
   browser sign-in on first push):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\publish-fork.ps1 -GitHubUser <YOUR-USERNAME>
   ```

   Manual equivalent, if you prefer plain Git — set identity first
   if needed (`git config --global user.name` / `user.email`):

   ```powershell
   git add -- package.json src/platforms/tizen/config.xml src/ui/styles.css test/skin.test.js docs/install/tizenbrew-fork.md publish-fork.ps1
   git commit -m "Midnight skin for the TV UI"
   git remote set-url origin https://github.com/<YOUR-USERNAME>/smarttv-twitch.git
   git push -u origin master
   ```

3. On your fork's GitHub page: **Releases → Draft a new release**,
   tag `v4.1.0`, title `v4.1.0 Midnight skin`, **Publish release**
   (a draft does not count — jsDelivr only sees published releases).

## 2. Add it on the TV

Confirmed on this network: the TQ55Q80D at `192.168.1.26` already
runs TizenBrew 2.0.5 with Developer Mode on, so no PC-side TV setup
remains.

1. Open **TizenBrew** on the TV.
2. Open **Module Manager → Add GitHub module**.
3. Enter `<YOUR-USERNAME>/smarttv-twitch` and confirm.
4. Back in **Module Manager**, select **Twellie** to launch it.

Watching works immediately without an account. To get the
**Following** tab, open the purple **Log in** pill in the top bar and
approve the device code on your phone — see [../LOGIN.md](../LOGIN.md).

## Verify on the TV (please report back)

1. **Module appears:** after the add, Module Manager lists **Twellie**.
2. **Launch:** the Channels grid loads with thumbnails; the active
   tab has a purple underline and the **Log in** pill is purple.
3. **Navigate:** the D-pad moves a white frame tile to tile and rows
   scroll; **red** = Channels, **green** = Categories,
   **yellow** = Following.
4. **Playback:** press OK on a stream — video goes full-screen.
   Note roughly how long the first picture takes.
5. **Quality:** press OK or Up for the overlay, choose **Quality**,
   move with Up/Down — playback continues at the new quality.
6. **Chat:** in the overlay choose **Chat** — a rail opens on the
   right with live messages and the video shrinks beside it.
7. **Back:** returns to the grid and the stream stops.
8. **Login (optional):** Up to the **Log in** pill, approve the code
   or QR at <https://www.twitch.tv/activate> on your phone, and
   confirm **Following** lists your live channels.

If anything fails, note the step number, the exact on-screen error
(a photo helps), and the TV software version from
**Settings → Support → About This TV**.

## Preview on this PC (no TV needed)

```powershell
npm start
```

Then open <http://localhost:8080/> in a browser (arrow keys +
Enter/Backspace stand in for the remote). The same preview is
reachable on the LAN at `http://<this-PCs-IP>:8080/`. The preview's
dev proxy is development-only; the TV build talks to Twitch directly.

## Options

- **German UI:** set `language: 'de'` in `src/core/config.js`,
  commit, push, and publish a new release (12 languages ship in
  `src/lang/`; the TV currently reports `en_GB`, so English is the
  matching default).
- **Watch today, skin later:** upstream `nkatchik/smarttv-twitch`
  can be added in TizenBrew right now with the stock look; adding
  your fork afterwards gives you the Midnight version as its own
  module entry.

## If the TV shows an old version

Publish a newer GitHub Release (bump with
`node tools/version.js <x.y.z>` first so `package.json` and the
Tizen `config.xml` stay in sync). jsDelivr caches aggressively;
upstream's `npm run tizenbrew:check` helper is hardcoded to the
upstream repository and can be ignored for this fork.
