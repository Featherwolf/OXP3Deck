# OXP3 Deck

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for the **ONEXPLAYER 3** (Intel Panther
Lake, Arc B390) on **CachyOS** (the Handheld Edition) and **Bazzite**. From one Quick Access panel in Game Mode, it
installs, sets up and updates two things, and it sets the power limits:

1. **oxp3-tool**, from [OXP3-Tool-for-Bazzite](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite): the controller,
   sleep and display fixes, the button layout and the kernel switch. The plugin runs `oxp3-tool` as root and shows
   what it says. It has no fixes of its own.
2. **xess-xmx-linux**, by [HHHHanasak1](https://github.com/HHHHanasak1/xess-xmx-linux): XeSS super resolution and
   frame generation on the GPU's XMX cores instead of the slower DP4a path, with patched Mesa drivers. The plugin
   also sets its per-game launch options for you.
3. **Power control**, built in: the sustained (PL1) and boost (PL2) power limits (TDP), the Arc GPU's clock range
   and the CPU's energy preference and boost, with a default profile, per-game profiles and optional separate values
   on AC. It replaces SimpleDeckyTDP on the OXP3 (see [Power](#power-tdp-and-gpu-clocks)).

It is modelled on [ClawDeck](https://github.com/IHulkSmashI/ClawDeck), the same kind of plugin for the MSI Claw (see
[Credits](#credits)).

> **Status: new, and not yet tested on a real device.** If something goes wrong, save a diagnose archive on the
> Updates & logs page and attach it to an issue.

## Install

You need Decky Loader. In Desktop Mode, open Konsole and run Decky's own installer as your user:

```bash
curl -L https://github.com/SteamDeckHomebrew/decky-installer/releases/latest/download/install_release.sh | sh
```

Then, in Game Mode:

1. Open Quick Access (the ONEX key) and go to Decky (the plug icon). Open Decky's settings (the gear).
2. Under **General**, turn on **Developer mode**.
3. Open **Developer**. Under **Install Plugin from URL**, enter this address and tap **Install**:

   ```
   https://raw.githubusercontent.com/Featherwolf/OXP3Deck/HEAD/release/OXP3Deck.zip
   ```

4. Confirm. OXP3 Deck appears in Decky's list.

You can also download [`OXP3Deck.zip`](release/OXP3Deck.zip) and pick it with **Install Plugin from ZIP File** >
**Browse**. Keep the file name `OXP3Deck.zip`: Decky uses it to find the installed copy it replaces.

To update the plugin, install it the same way again. Your settings and logs stay: they live outside the plugin's
folder.

## First steps

1. Open **OXP3 Deck** in Quick Access. **Status** shows the device and the system.
2. If oxp3-tool is missing or too old (the plugin needs 0.4.1 or later), tap **Install** or **Update**. It puts
   oxp3-tool at `/usr/local/bin/oxp3-tool`, where `get.sh` puts it, so `sudo oxp3-tool` keeps working in Konsole.
3. Tap **Apply** under the recommended fixes. It shows the plan and asks first. If a fix needs a reboot, a
   **Reboot** button appears.
4. Close any game, then tap **Install XeSS XMX**. It downloads the newest release (about 16 MB) and runs its
   `install.sh` as your user. That script downloads Intel's shader compiler and XeSS SDK, a few hundred MB more, so
   this takes a while.
   - Already installed by hand, for example in `~/Documents/xess-xmx-linux-20261031`? The plugin finds it and
     shows it as installed. There is no need to install it again.
5. Log out and back in, or reboot. Steam keeps its old Vulkan driver settings until then.
6. Start a game and open Quick Access. **This game** shows its XeSS options.

## The pages

**Quick panel** (Quick Access):

- **Status:** the device and OS. A red **Do not reboot** line when oxp3-tool could not finish rebuilding the boot
  entries. **Reboot to finish** when a change waits for a reboot. The running task and its last log line.
- **Power:** what the power limits and the GPU clock are now, and the active profile. **TDP control** on or off,
  then **Profile for this game**, **Sustained power**, **Boost power**, **GPU max clock** and **CPU boost**. Red
  lines when another power manager is in the way or something changed the limits behind OXP3 Deck's back.
- **oxp3-tool:** Install or Update when it is missing or old. The recommended fixes not applied yet, with Apply.
- **XeSS:** the driver status (is the patched driver in use, is a re-login needed) and Install, Update or Repair.
- **This game** (only while a game runs): the XeSS launch options as dropdowns, and advice for that game.
- **More:** the full page, with these tabs.

**Power:** the limits each RAPL interface reads now (MSR and MMIO side by side), the GPU clock and why it is
throttled, EPP, boost and governor. The options (per-game profiles, separate values on AC, more than 40 W on AC), the
editor for every profile (also GPU min clock, energy preference and **Use firmware values**), the other power
managers found with how to turn each one off, the firmware's own values, and **Import from SimpleDeckyTDP**.

**Fixes:** every oxp3-tool fix with its state, notes and when it takes effect. Apply and Revert for each one. Both
show the plan first.

**Buttons:** what each key does (keyboard, Home, ONEX and Xbox keys), the frame-limit value, and **Apply layout**.
That applies the `buttons` fix, and `xbox-key` too when your Xbox key needs its helper.

**XeSS:** the installed version and folder, the driver check, the default Mesa driver for all games, Install,
Update, Repair and Uninstall. Also the system Protons and whether they have the shim, missing tools, downloads
`install.sh` could not fetch, and old package folders you can remove.

**Games:** the running game, or the last one. The same options as the quick panel, plus the full advice: the XeSS
version in the game's folder, which Proton it uses, and what its last run logged (XMX, a fallback to DP4a, a kernel
that did not compile).

**Kernel** (CachyOS with Limine only): the installed kernels and what boots next. **Try** boots another kernel once.
If it hangs, hold the power button: the next boot is the kernel you have now, with no keyboard needed. **Keep**, on
the kernel you want, sets Limine back to booting whatever booted last. See
[Trying another kernel](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#trying-another-kernel-cachyos).

**Updates & logs:** oxp3-tool and xess-xmx-linux versions with update checks, the diagnose archive, and the last
tasks with their logs.

## Power (TDP and GPU clocks)

Off until you turn **TDP control** on (Quick Access → OXP3 Deck → Power). Then OXP3 Deck sets, from the active
profile:

- **Sustained power** (PL1, the long-term limit) and **Boost power** (PL2, a few seconds above it), written to
  **both** of the CPU's power-limit interfaces, `intel-rapl` (MSR) and `intel-rapl-mmio`. The CPU obeys the lower of
  the two, and the Arc GPU follows the MSR one: with only MMIO set (what SimpleDeckyTDP does), the GPU stays held at
  about 33 W. The firmware also rewrites the MMIO limits whenever the charger goes in or out, so OXP3 Deck writes
  them again after every AC change and every resume. PL4 and the other zones are never touched; if another tool
  left PL4 (the peak limit) below the boost limit, a red line says so (a reboot restores it).
- **GPU min and max clock** on the xe driver (the render GT only; the media engine keeps its own range).
- **Energy preference (EPP)** and **CPU boost** (turbo), on the full page; CPU boost is in Quick Access too.

**Range.** Sustained 5 to 35 W on battery and up to 40 W on AC (ONEXPLAYER's own figures for the OXP3: 35 W
sustained, "up to 40 W"). **Allow more than 40 W on AC** on the Power tab goes up to the firmware's own boost limit
(52 W): use a charger of 65 W or more, a weaker one cannot keep up. Boost is never below sustained and never above
the firmware's boost limit. On another device the limits never go above what its firmware set.

**Profiles.** The default profile starts with every value at "firmware" (the value the system booted with), so
turning control on changes nothing until you move a slider. **Profile for this game** gives the running game its
own copy; it is used whenever that game runs (per-game profiles on). With **Separate values on AC**, each profile
has a second set for when the charger is in. Profiles are re-applied after sleep, on a game change and on AC
changes.

**Turning it off or rebooting gives the firmware values back.** Turning TDP control off writes back the values read
when TDP control first changed something this boot (if another tool had changed a limit before that, its value is
what comes back; a reboot gives the firmware's own); a reboot resets them anyway. Updating, reloading or uninstalling OXP3 Deck
leaves the current limits in place until the next reboot (Decky runs the same cleanup for an update as for an
uninstall, and a game's limits should not drop mid-session).

**It does not fight.** If something else changes a limit OXP3 Deck set (outside the few seconds after an AC change
or a resume, when the firmware does that), it stops writing and shows a red line with the likely culprit and
**Take control again**. Nothing is written in a loop.

### Moving from SimpleDeckyTDP

1. On the **Power** tab (Quick Access → OXP3 Deck → More), tap **Import from SimpleDeckyTDP**. It copies its default
   and per-game TDP, GPU clock range and CPU boost values (per-game profiles and AC profiles only if they were on in
   SimpleDeckyTDP); its single TDP value becomes the sustained limit, and boost stays at the firmware's.
   SimpleDeckyTDP's files are left alone.
2. **Uninstall SimpleDeckyTDP first, or at least disable it**: Decky's settings (the gear) → **Plugins** → the menu
   next to SimpleDeckyTDP → **Uninstall** (or **Disable**). Two plugins setting the same limits undo each other;
   OXP3 Deck refuses to turn on while SimpleDeckyTDP (or PowerControl / PowerTools) is enabled.
3. Turn **TDP control** on.
4. In Steam's own Quick Access → **Performance**, turn off **TDP limit** and **Manual GPU clock**: Steam then
   changes the same limits.

### Other power managers

OXP3 Deck never stops, disables or masks another service: it tells you what runs and how to turn it off. Those
marked "blocks" keep TDP control from turning on (and pause it if they start later); those marked "EPP" only leave
the energy preference and CPU boost to them; "I have done that" on the Power tab acknowledges the ones where only
you can tell whether they still set the limits.

| Found | Effect | What to do |
|---|---|---|
| SimpleDeckyTDP, PowerControl or PowerTools (Decky plugins) | blocks | Decky → Settings → Plugins: disable or uninstall it (import from SimpleDeckyTDP first) |
| PowerStation (`powerstation.service`, Bazzite) | blocks | `sudo systemctl disable --now powerstation.service`; Steam's TDP slider uses it. Back after a reboot? `sudo systemctl mask powerstation.service` |
| thermald | blocks | `sudo systemctl disable --now thermald`: on Panther Lake it rewrites PL1 within seconds |
| Handheld Daemon (`hhd`) | blocks, can be acknowledged | turn off TDP control in Handheld Daemon's settings, then **I have done that** |
| `oxp3-tdp-sync.service` | blocks | `sudo systemctl disable --now oxp3-tdp-sync.service` (it copies MMIO PL1 into MSR; OXP3 Deck writes both) |
| `onex3-tdp.service` | blocks | `sudo systemctl disable --now onex3-tdp.service` |
| a steamos-manager TDP remote (`remotes.d` file with `TdpLimit1`) | blocks, can be acknowledged | turn Steam's **TDP limit** off, or remove that file |
| power-profiles-daemon | EPP | `sudo systemctl disable --now power-profiles-daemon` |
| tuned / tuned-ppd | EPP | `sudo systemctl disable --now tuned tuned-ppd` |
| intel_lpmd (CachyOS enables it on Panther Lake) | EPP | `sudo systemctl disable --now intel_lpmd` (it sets EPP and parks cores, not the power limits) |

**The thermald trade-off.** Disabling thermald does not leave the OXP3 unprotected: the SoC's own thermal limit
(it throttles at its maximum temperature) and the fan curve still apply. What you lose is thermald lowering PL1
early to keep the case cooler; set a lower sustained limit instead if the device gets too warm in your hands.

## How updates work

### oxp3-tool

- The plugin carries its own copy (`bin/oxp3-tool`, checked against its SHA-256). Updates & logs compares the
  installed version with that copy and with the newest one on GitHub.
- **Update** installs either the plugin's copy or the newest `dist/oxp3-tool` from GitHub (the file `get.sh`
  installs), checked against its published SHA-256.
- Fixes you applied keep working. If `status` says a helper is from an older version, apply that fix again.

### xess-xmx-linux

- **Each release gets its own folder** in `~/.local/share/oxp3deck/xess/`, such as `xess-xmx-linux-20261104`.
  Unpacking over the old folder would break the driver that Steam and games have loaded.
- **An update** runs the old folder's `uninstall.sh`, then the new folder's `install.sh`, both as your user. Then
  log out and back in. The compiler and the SDKs are copied from the old folder when the new release downloads the
  same versions (from 20261031 to 20261104 that saves the compiler's 95 MB).
- **The old folder stays** until after that re-login, because Steam still uses its driver until then. The XeSS page
  lists it under old package folders, with a button to remove it; not while it has the only compiler (the new
  folder's download failed). A git checkout, or a folder not named `xess-xmx-linux-<tag>` that the plugin did not
  install, is yours to delete: the page lists it without a Remove button.
- **A hand install** such as `~/Documents/xess-xmx-linux-20261031` is adopted: the plugin shows it, and updates it
  the same way. Its folder is kept like any old folder.
- **Update** is offered only for a release newer than the installed one. **Repair** runs `install.sh` of the
  installed release again in its folder, with nothing uninstalled, when the plugin finds it unfinished (for
  example the compiler download failed); the button says why. Repair also works when GitHub cannot be reached
  or is limiting requests, since it needs no release lookup.
- **Your default Mesa driver is kept** when you chose it on the XeSS page. Each release brings its own default. The
  plugin remembers your choice and sets it again after an update. A driver switched by hand with
  `tools/switch-driver.sh` is not carried over: pick it on the XeSS page once.
- **System Protons** such as CachyOS's `proton-cachyos-native` and `proton-cachyos-slr` live in
  `/usr/share/steam/compatibilitytools.d`, where `install.sh` cannot write. Games on them would stay on DP4a. The
  plugin adds the shim to them as root at the end of Install and Update, and when you tap the button on the XeSS
  page, and keeps the stock file next to it. A pacman update of such a Proton brings the stock file back; the
  plugin then adds the shim again when it next starts (at boot), or when you tap the button.
- **Check for an update** only asks GitHub for the newest release. It changes nothing.

## Per-game launch options

The plugin writes these into the game's Steam launch options, before `%command%`. A change applies at the game's
next start. No re-login is needed.

| Option | What it does | When to use it |
|---|---|---|
| `XESS=latest` | The game uses the XeSS libraries of Intel's XeSS SDK instead of its own older ones. They are swapped in only while the game runs, so Steam still sees the game as shipped. | The game's XeSS is older than 2.0.2.68 (XeSS then looks like DP4a, or offers no frame generation), or simply old. The Games page says so. |
| `XESS=dp4a` | XeSS without Intel's extension: super resolution on DP4a, frame generation on its generic path (2x only). | Comparing, or ruling out the XMX path as the cause of a problem. |
| `XESS_FG=2`, `3`, `4` | XeSS frame generation makes 2x, 3x or 4x frames, whatever the game's menu chooses. Frame generation must still be on in the game. | A game that offers only 2x. |
| `XESS_FG=5` to `8` | **Experimental**: beyond what Intel supports. 7x and 8x add a lot of latency. | A high refresh rate display that 4x does not fill. |
| `MESA=26.1`, `MESA=26.3` | This game uses that patched Mesa driver instead of the default. | A game misbehaves on one of the drivers. |
| `force_vk_vendor=-1` | Hides the Intel GPU from the game, so Mesa's own profile for it applies. XeSS then runs on DP4a. | A game that needs Mesa's workaround. |
| `XESS_LOG=1` | Writes the shim's, XeLL's and XeSS frame generation's logs into the game's prefix (`C:\igdext_trace.log`, `igdext_xell.log`, `igdext_xefg.log`, `igcl_stub.log`). | A bug report. |
| `FSR=xess` | The game's FSR 3.1+ upscaling runs on XeSS super resolution, and its FSR frame generation on XeSS frame generation. Needs xess-xmx-linux 20261104 or later. | A game with FSR 3.1+ and no XeSS. A game that has XeSS should use it. |
| `FSR_FG=xess` | Only the game's FSR frame generation runs on XeSS frame generation. Needs 20261104 or later. | As `FSR=xess`, but keeping the game's own FSR upscaling. |
| `FSR=xess FSR_FG=inject` | Adds XeSS frame generation to a game with FSR 3.1+ upscaling but no FSR frame generation. Needs 20261104 or later. | A game whose frame generation is DLSS only. |

- `XESS`, `XESS_LOG`, `FSR` and `FSR_FG` work through a small hook that `install.sh` puts into each Proton it can
  write to. The Games page says whether the game's Proton has the shim and the hook. Without the shim, XeSS stays on
  DP4a.
- Keep a frame limit on with frame generation, or the generated frames reach the screen unevenly.
- Everything else in the launch options stays as you wrote it: wrappers such as `gamemoderun`, other variables, and
  the game's own arguments. Options without `%command%` are game arguments, so the plugin writes
  `VARIABLES %command% ARGUMENTS`, with each argument in quotes where the shell would read it otherwise
  (`-name (Player One)` becomes `-name '(Player' 'One)'`; a backslash, as in `C:\Games\cfg.ini`, stays as it is).
  A `%command` without its closing `%` is shown as a warning.

## What it never does

- **It changes nothing without a tap.** Fixes, installs, updates and reboots ask first.
- **Uninstalling the plugin reverts nothing and removes nothing.** Decky runs the same cleanup on every update of a
  plugin, so the plugin cannot tell a removal from an update. To undo things, use the buttons first: Revert on the
  Fixes page, Uninstall on the XeSS page. To remove oxp3-tool itself, see
  [Uninstall](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#uninstall).
- It never runs xess-xmx-linux's scripts as root. They run as your user, with a clean environment, so nothing of
  Decky's ends up in your session.
- It never stops a running oxp3-tool or xess-xmx-linux script halfway.
- It installs no system packages. The XeSS page lists tools that are missing, for you to install with pacman.
- It changes no launch option except the ones in the table above.
- **Uninstalling or disabling leaves the current power limits, GPU clock range and energy preference until the
  next reboot.** Turn TDP control off first to get the firmware's values back at once (SimpleDeckyTDP cannot reset
  the xe GPU clocks if you go back to it).
- It writes no power limit until you turn TDP control on, never PL4 or the GPU's media engine, and it never stops
  or disables another power manager (it shows the command for you to run).

## Troubleshooting

- **The plugin's log** is in `~/homebrew/logs/OXP3Deck/`, one file per start (Decky keeps the newest few).
- **Updates & logs** shows the last tasks and their full logs. **Save a diagnose archive** writes
  `~/oxp3-diagnose-<time>.tar.gz`. Attach it to an issue.
- **Do not reboot** (red): a boot-entry rebuild did not finish. Reboot only after the command the warning names has
  run without errors. See [CachyOS](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#cachyos).
- **A task shows "interrupted"** after Decky or the plugin restarted or was updated: the plugin stopped following
  it, but what it started (oxp3-tool, install.sh, uninstall.sh) runs to its end. Open the page again when it has
  ended to see the result. The plugin does not reboot while oxp3-tool still runs, and the XeSS buttons wait while
  such an xess-xmx-linux script still runs (the XeSS page says so).
- **Re-login needed:** XeSS was installed or updated, but Steam still runs with the old driver settings. Log out and
  back in, or reboot.
- **XeSS driver check failed:** the XeSS page shows the line from `~/.cache/xess-xmx/driver-status`.
  `journalctl --user -u xess-xmx-check` has the details. When the new driver fails that check at the end of an
  install or update, the plugin runs the check again at once: it switches to the package's other driver, or to the
  system's stock driver (XeSS on DP4a). When an install or update ends with "Reboot (not just log out)", that did not
  work: reboot, because the check runs again at boot, and after only a log-out Game Mode may not start.
- **Steam from Flathub** (Flatpak) is not supported by xess-xmx-linux. The XeSS page says so.
- **The panel shows an error or does not load:** restart Decky with `sudo systemctl restart plugin_loader`, or
  reboot.
- The plugin keeps its settings in `~/homebrew/settings/OXP3Deck/settings.json` and task logs in
  `~/homebrew/data/OXP3Deck/jobs/`.

## Building from source

```bash
pnpm install
pnpm build    # the frontend: dist/index.js
pnpm zip      # release/OXP3Deck.zip (python3 tools/build_zip.py)
```

`tools/build_zip.py` packs the frontend, `main.py`, `py_modules/oxp3deck/*.py`, the docs and
`vendor/oxp3-tool` (checked against `vendor/oxp3-tool.sha256`) into one `OXP3Deck/` folder. The same files always
give the same zip. `--out FILE` writes it elsewhere.

`vendor/oxp3-tool` is a copy of `dist/oxp3-tool` from [OXP3-Tool-for-Bazzite](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite). To bundle a newer one:

```bash
python3 tools/vendor_oxp3_tool.py                  # the newest on GitHub (or --ref v0.4.1)
python3 tools/vendor_oxp3_tool.py --from ../OXP3-Tool-for-Bazzite   # a local checkout
pnpm zip
```

It only replaces `vendor/` when the file matches its SHA-256 and is at least the version the plugin needs
(`MIN_VERSION` in `py_modules/oxp3deck/oxp3tool.py`).

Releases: set the version in `package.json`, run `pnpm build && pnpm zip`, add the notes as
`release-notes/v0.2.0.md`, commit, then run Actions > Release > Run workflow with the version (`0.2.0`). It checks
that the version, `package.json` and the zip agree, creates the tag, and publishes `OXP3Deck.zip` with its SHA-256.
Versions below 1.0.0 are marked pre-release. Pushing an annotated tag works too; its message becomes the notes.

Tests:

```bash
python3 -m unittest discover -s tests -t . -v
ruff check .
node --experimental-strip-types --test tests/js/*.test.mjs   # launch options, xess offers (Node 22.6+, python3, sh)
pnpm typecheck
```

[DESIGN.md](DESIGN.md) describes how the backend and the frontend fit together.

## Credits

OXP3 Deck is modelled on [ClawDeck](https://github.com/IHulkSmashI/ClawDeck) by IHulkSmashI (MIT), and some of its
code is adapted from it. It drives [xess-xmx-linux](https://github.com/HHHHanasak1/xess-xmx-linux) by HHHHanasak1
(MIT), runs in [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader), and its build setup comes from
[decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template). [CREDITS.md](CREDITS.md) lists
the projects it builds on and what each one gives.

## License

OXP3 Deck is under the MIT License ([LICENSE](LICENSE)). The plugin zip also holds third-party code under its own
licences; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists it with the licence texts.
