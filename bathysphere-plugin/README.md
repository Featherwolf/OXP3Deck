<!--
SPDX-FileCopyrightText: 2026 Featherwolf
SPDX-License-Identifier: MIT
-->

# OXP3 Deck for Bathysphere

OXP3 Deck for the ONEXPLAYER 3 (Intel Core Ultra, Arc graphics), ported from the Decky Loader
plugin of the same name (0.7) to a sandboxed Bathysphere plugin. It does these things:

- **Power**: profiles for Default, for each game, plugged in and on low battery. They set boost
  power, the "steadier fps after loads" boost mode, the GPU speed range, energy preference (for all
  cores or per core type), CPU speed cap and minimum, per-core speed caps, the CPU vs GPU balance
  and the fan, through the ONEXPLAYER 3 hardware helper (`oxp3-hw`). Steam's own knobs (sustained
  power, CPU boost, GPU power saving, charge limit) are changed only when you change them. There
  are presets with a 30 s Undo, live readouts, power tips while you play, a device check and a 60 s
  power measurement.
- **Other power programs**: finds thermald, power-profiles-daemon, TuneD, Intel's low-power daemon,
  PowerStation, Handheld Daemon, old OXP3 TDP helpers, Steam TDP remotes and Decky power plugins. It
  explains each one, refuses to turn power control on while one of them would fight it, gives the
  steps to turn it off and back on, and notices when one comes back.
- **Fan and battery**: fan Auto, Quiet or Max per profile (with power control off it is set
  directly), charge limit, Run from charger, and rows for when the helper put the fan back to Auto
  or something else changed a setting.
- **XeSS fast mode** (xess-xmx-linux): whether it is installed and live, its driver check and
  services, the newest release, and the exact install, update, repair, driver switch and uninstall
  lines.
- **Per game**: XeSS version (the game's own, Latest, DP4a), frame generation 2x–4x (5x–8x with a
  setting), graphics driver, compatibility mode, DirectX 12, FSR → XeSS, XeSS logs for one run, and
  the whole launch line to copy by hand (with what the game needs). For a non-Steam shortcut, or a
  game whose launch options Steam does not return, the same choices make a line to paste. Also the
  XeSS and FidelityFX files in the game folder with
  their versions, what the last run's logs say, known issues, tips, and the game's own power
  profile. **Automatic setup** does the safe part of this by itself after you quit a game, with Undo,
  and undoes a change if the game closes within a minute.
- **Device fixes** (oxp3-tool): the state of every fix, the exact `sudo oxp3-tool …` line to apply,
  apply again or undo it, the button layout, the "try another kernel once" helper on CachyOS, the
  do-not-reboot warning and reboot-to-finish rows.

On any device other than the ONEXPLAYER 3 (system.info vendor `ONE-NETBOOK`, board
`ONEXPLAYER 3`) it makes no hardware call at all. The XeSS and per-game launch-option parts still
work there.

Systems: CachyOS (and Arch) get everything. On Bazzite, which the original also supported, the
XeSS and per-game parts work and the XeSS tools card uses `rpm-ostree`. The hardware helper is a
pacman package only, so there is no power, fan or charging control on Bazzite, and its install
card is not shown there. The `power-off` step for `oxp3-support` (`pacman -R`) is pacman's too.

## Surfaces

| Surface | What it shows |
|---|---|
| Quick Access tab `qam` (in Steam and in Home) | Status, then collapsible groups Live, This game, Power, CPU, Fan & battery, XeSS and Device fixes. The open state is remembered and a closed group shows a one-line summary. Alerts such as a blocking program, a change undone after a quick exit, fixes that need attention or "Do not reboot yet" stay visible while their group is closed. |
| Panel `main` (Bathysphere Home, overlay, web UI) | Tabs: Power, CPU & GPU, Fan & battery, Games, XeSS, Fixes, Buttons, Kernel (CachyOS only), Setup & updates. On another device: Games, XeSS, Setup & updates. |
| Game page section `game` | Everything for that game. Automatic setup runs once per session when the section opens. |

Background: the plugin keeps running while no surface is open (`background: true`). It does this
to write a game's waiting launch options after the game quits, to run automatic setup, to take
power-tip samples while a game runs, and to run the daily update check. Sensors are read only
while a surface shows them, or every 5 s for power tips while a game runs. Other power programs
are checked once a minute while a surface is open, and a value an interrupted device check could
not put back is written then. A render waits at most 3 s for these reads; a slow helper finishes
in the background and the surface is drawn again.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Profiles, options, UI choices, automatic-setup records, waiting launch options, dismissed tips, device-check results, update-check results. |
| `notifications` | Toasts for changes made in the background: automatic setup, its rollback, XeSS logging turned off after one run. |
| `network` | The update check, and only the two hosts below. |
| `steam.apps.read` | The installed games and their names, the running game (`app.started`, `app.stopped`, `steam.apps.running`), a game's Proton. |
| `steam.apps.launchOptions` | Reads and changes the declared launch-option keys only (see below), through the typed methods. Steam refuses changes while a game runs, so the plugin keeps them and writes them after the game quits. |
| `steam.gamefiles.read` | Finds XeSS and FidelityFX DLLs and their versions in the game folder, anti-cheat files, the XeSS shim's logs in the Proton prefix and the prefix's driver store. |
| `system.info` | The device gate (vendor and board), OS and kernel, battery and AC, the hardware helper's state, `hardware.changed` events. |
| `system.performance` | Steam's sustained power (TDP), CPU boost and GPU power saving, changed only when you change them. Also the CPU governor read and `system.power.conflicts`. |
| `system.battery` | Charge limit and Run from charger. |
| `system.sensors` | Package power, battery draw and time left, CPU temperature, GPU busy and throttle reasons, fan speed. |
| `system.power.advanced` | Boost power, energy preference, CPU limits, CPU vs GPU balance, GPU speed range, mostly through `system.profiles` rules. |
| `system.fan` | The fan mode in profile rules, or set directly while power control is off. Bathysphere Home asks you to confirm the first Quiet or Max. |
| `system.profiles` | The power profiles as hostd rules (Default, plugged in, low battery, per game), so they apply while OXP3 Deck is closed. |
| `fs.home.read` | xess-xmx-linux's environment file, driver-check status and compile log (its end shows in the driver check's Details), and its check unit (exact paths: `homeRead` in the manifest). |
| `session.env.read` | `VK_DRIVER_FILES` in the session and in Steam's environment, to tell whether Steam already uses the fast driver. |
| `systemd.user.read` | The states of `xess-xmx-check.service` and `xess-xmx-shim.path`. |
| `fs.system.read` | oxp3-tool's state file and boot marker, `/proc/cmdline` (pending kernel arguments), the helper's `/etc/oxp3-hw/limits.toml` and its steamos-manager remote file (exact paths: `systemRead`). |

Launch-option keys it may write (manifest `launchOptions`): `XESS` (`latest`, `dp4a`), `XESS_FG`
(2–8), `XESS_LOG` (1), `MESA` (a driver version), `force_vk_vendor` (-1), `FSR` (`xess`), `FSR_FG`
(`xess`, `inject`), and the argument `-dx12`. Bathysphere's parser keeps everything else in the
line exactly as it is.

## Network hosts

Both have `when: checkUpdates`. With the "Check daily for oxp3-tool and XeSS updates" setting
off, no request can leave the device. The plugin then does not even try. The setting is on by
default, as the original's daily check was; turn it off in the plugin's settings or on the Setup &
updates tab.

| Host | Request | Why |
|---|---|---|
| `api.github.com` | `GET /repos/Featherwolf/OXP3-Tool-for-Bazzite/contents/oxp3_tool/__init__.py` (raw media type) | The newest oxp3-tool version number. |
| `github.com` | `HEAD /HHHHanasak1/xess-xmx-linux/releases/latest` | The newest xess-xmx-linux tag, from the redirect. |
| `api.github.com` | `GET /repos/HHHHanasak1/xess-xmx-linux/releases/latest` | The same, when github.com does not redirect. |

A 403 or 429 shows "GitHub is limiting requests". The first check runs 3 minutes after start, then
once a day, never while a game runs. Only a check where both steps worked counts for the day: after
any failure (offline, rate limit, an answer that is not a release) it tries again after an hour.
"Check for updates now" runs it at once, in the background (each request gives up after 10 s). No
key or token is needed.

## "Run this yourself" cards

Bathysphere never runs anything as root. Each admin step is a reviewed instruction card in the
manifest (`contributes.instructions`), drawn by the host. Next to the card, the plugin shows the
exact line for your case in a code row with Copy (the fix id and its options, the release tag and
folder, the button choices, the kernel package). It then reads back what changed: the helper's
state, the conflict list, oxp3-tool's state file, xess-xmx-linux's files and units.

Cards: `hw-install`, `hw-ac-limit`, `hw-stop`, `power-off`, `power-on`, `hhd-tdp`,
`decky-leftovers`, `oxp3-tool-install`, `oxp3-tool-apply`, `oxp3-tool-fix`, `oxp3-tool-buttons`,
`oxp3-tool-kernel`, `oxp3-tool-diagnose`, `boot-entries`, `xess-tools`, `xess-tools-bazzite`, `xess-install`,
`xess-update`, `xess-manage`, `ge-proton`, `scx-mode`, `launch-typo`.

## How it differs from the Decky version

The Decky plugin had a root Python backend. This port has none: it runs in Bathysphere's sandbox
and reaches the system only through host methods, so some things work differently.

- **Hardware goes through the helper and hostd, not sysfs.** The Decky backend wrote RAPL, MMIO,
  EPP and fan registers as root. Here the `oxp3-hw` helper (Hw1 provider) does that within its own
  safe limits, and hostd applies the profiles as rules. They keep working after OXP3 Deck closes
  and come back after resume or a charger change. The plugin never fights another writer. When
  something else changes a knob, it shows a red row with Take control.
- **Sustained power, CPU boost, GPU power saving and the charge limit are Steam's.** Steam owns
  them (steamos-manager) and profile rules cannot contain them, so they are not per profile any
  more. Steam's own per-game profile keeps sustained power per game. Presets change them once, for
  the profile in use now.
- **"Steadier fps after loads"** uses the helper's follow mode: a fixed offset above sustained
  power, chosen when the profile is written (a quarter of it on battery, a half plugged in). The
  original recomputed +25 % / +50 % whenever sustained power changed.
- **Low battery** uses hostd's `batteryBelow` rules, on battery only (`power: "battery"`), so the
  low values end when you plug in, as in the original. They also end once the battery is back at
  the level + 2 % (hostd's hysteresis), not + 5 % as in the original.
- **Another power program does not pause power control.** The original stopped writing while a
  blocking program ran and went on by itself once it was gone. Here hostd keeps applying the
  profiles, and the hardware helper stops setting any knob it sees another program change (a red
  row with Take control). Turning power control on is still refused while one runs, and while the
  list of other programs cannot be read.
- **The fan with power control off** is set directly and applies now; with power control on it is
  part of each profile, as in the original.
- **System Protons** are recognised by name (`proton-cachyos`, `proton-cachyos-slr`,
  `proton-cachyos-native`): Bathysphere gives a game's Proton by its name only, not by the folder
  it is installed in, which the original checked. A user-installed proton-cachyos build has a
  version in its name and counts as a normal Proton.
- **The device check stops when OXP3 Deck closes.** Every hardware change needs an open surface.
  A value it could not put back is written again within a minute once a surface is open, and the
  Power tab has Put back.
- **Damaged stored values** (not an object) are kept as they are and nothing new is saved over
  them, until you choose Start fresh on the Setup & updates tab. The original also moved a copy
  aside; Bathysphere's storage has no files to move.
- **Admin work is cards, not buttons.** "Fix for me", "Fix all", installing oxp3-tool or
  xess-xmx-linux, applying fixes, the button layout and the kernel helper show the steps and the
  exact line. Nothing runs by itself. Masking units so D-Bus cannot start them again is not
  offered.
- **Confirms for the fan and charging are Bathysphere's.** The first Quiet or Max fan, the first
  Run from charger and the first charge limit below 80 % are confirmed once in Bathysphere Home. In
  Steam's Quick Access such a first change is refused, and a row says to make it once from Home.
- **Launch options are written while the game is closed.** Steam refuses changes while it runs, so
  the change is kept and written after the game quits ("Saved when you quit …"). A typo that
  Bathysphere's parser cannot read blocks writes until it is fixed in Steam. When Steam's write path
  is off, the plugin shows the whole line to paste.
- **Proton is read, never changed.** A game's Proton cannot be set from a plugin, so the "move to
  GE-Proton" step is a card.
- **Navigation**: Quick Access cannot open the panel, so "All settings" is a hint to open OXP3 Deck
  in Bathysphere Home.
- **Rule limit**: hostd takes at most 64 rules. When there are too many game profiles, the newest
  ones are applied and the row says how many are left out.

## Review notes

`bathys-plugin validate` (bathys-proto's manifest rules and tools/review's deterministic stage)
reports 0 errors and 38 warnings, all of medium severity:

- 17 `review.dataflow.remote-controls-hardware` and 2 `review.dataflow.remote-controls-action`:
  the dataflow check follows values through the shared `Stored` and `Cached` classes, so hardware
  writes, launch-option writes and toasts look fed by the update check. The update results
  (`updates.oxp3`, `updates.xess`) reach only display text and command lines: the xess-xmx-linux
  tag only after `SAFE_TAG` (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$`), the oxp3-tool version only
  after its version pattern. They never reach a `system.*`, launch-option or toast call.
- 15 `review.manifest.instruction-admin-command`: the admin cards are the root steps the user runs
  (Bathysphere never does root work, so these are cards by design).
- 3 `review.manifest.instruction-unpinned`: xess-xmx-linux publishes no checksum (its cards say
  so), and the oxp3-hw 0.1.0 package's SHA-256 is not known until its release is built, so
  `hw-install` links the hw-v0.1.0 release page and has the user compare the download's SHA-256
  with the one testers are sent. Pin the asset URL and its `sha256` in that card once the release
  is published (a changed card is a consent change).
- `review.manifest.network-when-default`: update checks are on by default, as in the original
  (see Network hosts).

`code` rows hold lines for the user to run. Each is built from the manifest's reviewed cards and
fixed tables (oxp3-tool's fix catalog, `MANAGED_DIR`), a tag that passed `SAFE_TAG`, a folder that
passed `quotePath` (single-quoted; quotes, line breaks, control and format characters refused),
oxp3-tool's boot-marker command only when it is one of the commands oxp3-tool writes, and launch
options whose game arguments are re-quoted as hostd does. Text with control or format characters
is never offered with Copy.

## Not included

- **OptiScaler** (install per game, choices, in-game steps, update, remove): out of scope for this
  port. It needs writing DLLs into game folders, which no Bathysphere method allows.
- **The root system-Proton shim** (putting the XeSS add-on into `/usr/share/steam/compatibilitytools.d`
  Protons and re-shimming after updates): out of scope. Bathysphere never does root work. Games on
  a system Proton (proton-cachyos) stay on DP4a, and the GE-Proton card says how to switch.
- Power time windows, the helper's cited device defaults, per-interface PL1/PL2/PL4 readings and
  the PL4-below-boost warning: no host method reads them.
- Import from SimpleDeckyTDP: `~/homebrew` is not readable.
- Unit masking (`systemctl mask`), per-profile CPU scheduler mode (scx_lavd) and pausing Intel's
  low-power daemon in games. hostd never calls them, so each is a card or a note.
- The variable-refresh "safe on this kernel" verdict and the display refresh notes: the inputs are
  outside the readable paths. `sudo oxp3-tool status` shows them.
- Interrupted oxp3-tool runs and its lock, user-installed Protons with their shim and hook, parts
  of an xess-xmx-linux install that did not download, an installer still running, Flatpak Steam
  detection, the 0.4 "add needed launch options automatically" rows, and OXP3 Deck's own release
  notice.

## Build, test, install

This folder is the Bathysphere plugin. The Decky plugin is the rest of this repository and is built
separately (see the top-level README). The plugin has no dependencies of its own: it uses a
[Bathysphere](https://github.com/Featherwolf/Bathysphere) checkout for the SDK sources
(`packages/sdk`), esbuild, acorn, TypeScript and the fake host (`packages/fake-host`).
`scripts/link.mjs` points `.bathysphere` at that checkout. It uses `BATHYSPHERE_DIR`, or else a
clone named `Bathysphere` or `bathysphere` next to this repository.

```sh
# once, in the Bathysphere checkout
npm ci && npm run build -w @bathysphere/sdk -w @bathysphere/fake-host

cd bathysphere-plugin
npm run typecheck     # tsc --noEmit (strict)
npm run build         # dist/manifest.json, dist/main.js, dist/assets/, README, LICENSE, CHANGELOG
npm test              # build, bundle the pure modules, then node --test test/*.test.mjs
npm run pack          # also writes oxp3deck-0.7.0.bpk (deterministic gzip ustar of dist/)
npm run clean
```

The tests run the built plugin in the fake host with a manual clock and no real network. The
fake world is an ONEXPLAYER 3 on CachyOS with the helper, a Steam library (The Witcher 3, Monster
Hunter Wilds, Dota 2), xess-xmx-linux's files and oxp3-tool's state file. Every surface and tab
also renders in the real `bathys-runtime` sandbox when the checkout's `target/debug/bathys-runtime`
is built (`cargo build -p bathys-runtime` there), or `BATHYS_RUNTIME_BIN` names one.

Install as a developer-mode local package:

```sh
bathys settings set developerMode on
bathys install --file oxp3deck-0.7.0.bpk
```

Bathysphere asks you to approve the permissions and network hosts in the terminal or in Home.
For the hardware parts, install the `oxp3-hw` helper first. The `hw-install` card on the Power tab
shows how. Fan and charging need Linux 7.4 or newer.

## Layout

```
scripts/build.mjs     bundle and checks; --pack writes the .bpk
scripts/link.mjs      points .bathysphere at a Bathysphere checkout
src/main.tsx          activate, events, surfaces
src/schedule.ts       live readouts, after-exit work, daily checks, library scan, housekeeping
src/core/             text rules, clock, errors, caches, storage, write queue, redraw, undo
src/device/           system.info and the ONEXPLAYER 3 gate
src/hw/               knob snapshot and Steam-owned knob writes
src/power/            profiles, rules, apply, conflicts, live, advisor, device check
src/xess/             xess-xmx-linux detection, releases, command lines
src/games/            running games, launch options, game files, advice, known issues, one-run logs, automatic setup
src/oxp3tool/         catalog (assets/oxp3-tool-catalog.json), state file, command lines
src/updates/          update checks
src/ui/               Quick Access, panel tabs, game section, shared rows
test/                 pure.test.mjs (unit) and fake-host tests per area
```

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Featherwolf.
