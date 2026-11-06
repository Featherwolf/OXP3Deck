# Credits

The licence texts of the projects below, and where their parts are, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## ClawDeck

OXP3 Deck is modelled on [ClawDeck](https://github.com/IHulkSmashI/ClawDeck), a Decky Loader plugin for the MSI
Claw on Bazzite. MIT License, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors.

Adapted from it:

- **Backend:** the start of `main.py` (py_modules on sys.path, Decky's PyInstaller variables undone before
  `import decky`, one executor call per method), undoing those variables for child programs (`env.py`), HTTPS with
  the system's CA certificates (`tls.py`), running commands as the desktop user (`userexec.py`), and GitHub release
  lookups, downloads and safe unpacking (`downloads.py`).
- **Frontend:** the Quick Access panel with a full page behind it and its routes and tabs (`index.tsx`, `nav.ts`,
  `pages/Quick.tsx`, `pages/Full.tsx`), confirmation dialogs and hints (`components/confirm.tsx`,
  `components/Hint.tsx`), the per-game controls (`components/GameControls.tsx`), Steam's running game and launch
  options (`steam.ts`) and the typed backend calls (`api.ts`).
- **Tests:** loading `main.py` with a stand-in `decky` module, and the check that `api.ts` and `main.py` name the
  same methods (`tests/test_main.py`).

Each adapted file starts with the line "Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck
contributors)." ClawDeck's licence notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Also following ClawDeck's approach, without its code: how `xess.py` finds the installed package (VK_DRIVER_FILES in
50-xess-xmx.conf) and reads the driver check and the drivers (~/.cache/xess-xmx/driver-status, lib/mesa-*,
lib/active).

Also following ClawDeck's approach, without its code: OptiScaler per game with a manifest and backups, the
subfolder layout, `XESS_FG` with OptiScaler's XeFG and the DXVK vendor id for 3x/4x (`optiscaler.py`, as of ClawDeck
commit 07918cc and its later notes). ClawDeck is under AGPLv3 since 2026-11-05 (commit 47559f4) and its
`assets/games.json` is GPL-3.0 (derived from OptiScaler): neither is copied; OXP3 Deck's games table is written by
hand from OptiScaler's own wiki and source.

Power control (`powerhw.py`, `power.py`) also learned from ClawDeck's Panther Lake measurements on the MSI Claw
(its `docs/HARDWARE-FINDINGS.md`), without its code: RAPL limits written PL2 before PL1 when raising (§12), only the
xe render GT (`gt0`) changed and never the media GT (§1, item 3), and thermald rewriting the power limits within
seconds (§21).

## SimpleDeckyTDP

[SimpleDeckyTDP](https://github.com/aarron-lee/SimpleDeckyTDP) by Aarron Lee (BSD-3-Clause, Copyright (c) 2023,
Aarron Lee) is the TDP plugin OXP3 Deck's power control replaces on the OXP3. Its ideas are followed, without its
code: the profile model (a default profile, per-game profiles by Steam app id, separate `-ac-power` values), applying
again after a resume with a short delay, and its `settings.json` format, which **Import from SimpleDeckyTDP** reads
as data (`tdpProfiles`, `enableTdpProfiles`, `advanced.acPowerProfiles`). No SimpleDeckyTDP code is in OXP3 Deck, so
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) has no section for it.

## Research sources for power control

Read to learn how other tools set the same limits, so OXP3 Deck can detect them and not fight them; no code from
them is in OXP3 Deck:

- [Handheld Daemon](https://github.com/hhd-dev/hhd) (LGPL-2.1): its TDP control writes PL1, PL2 and PL4
  (`adjustor/core/rapl.py`), which is why OXP3 Deck warns when PL4 is left below the boost limit.
- [PowerStation](https://github.com/ShadowBlip/PowerStation) (GPL-3.0): the service behind Steam's TDP slider on
  Bazzite.
- [ONEXPLAYER 3 SteamOS setup](https://github.com/HHHHanasak1/onexplayer3-steamos-setup) (MIT): the finding that the
  Arc GPU follows the MSR PL1, not the MMIO one.

## Sources for the extras (scheduler mode, intel_lpmd)

`extras.py` calls two D-Bus services. Their names, arguments and behaviour were taken from their sources; no code from
them is in OXP3 Deck:

- [scx-loader](https://github.com/sched-ext/scx-loader) (GPL-2.0-only), read at commit 259bb6c
  (`configs/org.scx.Loader.xml`, `crates/scx_loader/src/dbus.rs`): the `org.scx.Loader` properties
  `CurrentScheduler`, `SchedulerMode` and `CurrentSchedulerArgs` and the methods `SwitchScheduler` and
  `SwitchSchedulerWithArgs`, which set CachyOS's scx_lavd mode.
- [intel-lpmd](https://github.com/intel/intel-lpmd) (GPL-2.0), read at commit 9ece012
  (`src/intel_lpmd_dbus_interface.xml`, `src/lpmd_dbus_server.c`): the methods `LPM_FORCE_OFF`, `LPM_AUTO`,
  `LPM_FORCE_ON` and `GetState`. They need root, and the daemon takes only one such call every 2 seconds.

## xess-xmx-linux

[xess-xmx-linux](https://github.com/HHHHanasak1/xess-xmx-linux) by HHHHanasak1 runs XeSS super resolution and frame
generation on the XMX cores of Intel Arc GPUs under Linux. It brings patched Mesa drivers, a shim for Proton and the
per-game launch options. MIT License, Copyright (c) 2026 HHHHanasak1. The parts it uses from others (Mesa, Intel's
XeSS SDK and graphics compiler, AMD FidelityFX and more) keep their own licences, listed in its `THIRD_PARTY.md`.

The plugin you install does not include xess-xmx-linux itself: when you tap Install or Update, it downloads a release
from the project's GitHub releases and runs the project's own scripts as your user. The option descriptions in
[README.md](README.md) and in the per-game controls (`src/components/GameControls.tsx`) follow its
`docs/launch-options.md`, partly in its words. The repository's `tests/fixtures/xess/` holds five of its scripts
unchanged for the tests (`get-igc.sh` and `get-xess.sh` of 20261031; `get-igc.sh`, `get-xess.sh` and `get-ffx.sh`
of 20261104), with its licence in `tests/fixtures/xess/LICENSE`.

## OptiScaler

[OptiScaler](https://github.com/optiscaler/OptiScaler) by cdozdil and the OptiScaler contributors (GPL-3.0) takes
a game's DLSS, XeSS or FSR calls and runs another upscaler and frame generation in their place. For The Witcher 3,
OXP3 Deck downloads a pinned OptiScaler build from its GitHub release when you tap Install, and puts it into the
game's folder; the game is set to DLSS and DLSS frame generation, and OptiScaler runs XeSS and XeSS frame generation.
OptiScaler is not part of OXP3 Deck and is never run by it ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) says
what is downloaded and where it goes).

Sources of the games table in `optiscaler.py` (facts, no code): OptiScaler's wiki page
[The Witcher 3: Wild Hunt](https://github.com/optiscaler/OptiScaler/wiki/The-Witcher-3-Wild-Hunt) (the
`bin/x64_dx12` folder, `dxgi.dll`, DirectX 12, the known issues), its `OptiScaler/GameConfigs.cpp` and
`OptiScaler.ini` (Dxgi spoofing off for `witcher3.exe`; the ini keys and values OXP3 Deck sets) and its release
notes. The route itself (DLSS and DLSS frame generation in the game, XeSS and XeFG from OptiScaler, on the same
chip) comes from ETA Prime's video of ClawDeck on SteamOS. xess-xmx-linux's `docs/games.md` gave its OptiScaler
recipe (Dxgi spoofing off, `WINEDLLOVERRIDES=dxgi=n,b`) and its `docs/debugging.md` the need for `force_vk_vendor=0`
in The Witcher 3. [Decky Framegen](https://github.com/xXJSONDeruloXx/Decky-Framegen) is named because OXP3 Deck
detects its installs (its `framegen_patch` marker and `.b` backups) and leaves them alone.

## Decky Loader

[Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) (GPL-2.0) loads and runs the plugin.
`dist/index.js` includes `@decky/api` (LGPL-2.1; its licence, its source and how to replace it are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) and uses `@decky/ui` (LGPL-2.1), which Decky provides at run time.
Both are by the SteamDeckHomebrew team. The frontend is built with `@decky/rollup` (BSD-3-Clause).

## decky-plugin-template

[decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template) by the SteamDeckHomebrew team
(BSD 3-Clause License, Copyright (c) 2022-2024, Steam Deck Homebrew): the plugin layout and build setup
(`rollup.config.js`, `tsconfig.json`, the `package.json` scripts, `plugin.json`) follow it, and `decky.pyi` is its
file unchanged.

## Icons

`dist/index.js` includes [react-icons](https://github.com/react-icons/react-icons) 5.5.0 (MIT, Copyright 2018
kamijin_fanta): its icon component and eight of its icons, which are Google's
[Material Design icons](https://github.com/google/material-design-icons) (Apache License 2.0).

## oxp3-tool

`bin/oxp3-tool` is oxp3-tool from
[OXP3-Tool-for-Bazzite](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite) (its `dist/oxp3-tool`, kept here
in `vendor/`), MIT License, Copyright (c) 2026 Featherwolf. Its `LICENSE` and `THIRD_PARTY_NOTICES.md` are packed
inside it (`unzip -p bin/oxp3-tool LICENSE`). Where its fixes come from is in its
[README](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#background-and-credits). Its gamescope display profile is
modelled on [gamescope](https://github.com/ValveSoftware/gamescope)'s for the same panel (BSD-2-Clause) and on the
[ONEXPLAYER 3 SteamOS setup](https://github.com/HHHHanasak1/onexplayer3-steamos-setup) fix pack's (MIT).

## Trademarks

OXP3 Deck is an unofficial community project, not affiliated with or endorsed by ONE-NETBOOK (ONEXPLAYER), Intel,
AMD, Valve, Universal Blue (Bazzite) or CachyOS. ONEXPLAYER, Intel Arc, XeSS, FSR and Steam are trademarks of their
owners.
