# OXP3 Deck: design

A Decky Loader plugin for the ONEXPLAYER 3 that installs, configures and updates, from one Quick Access panel:

1. **oxp3-tool** ([OXP3-Tool-for-Bazzite](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite)): the controller, sleep and display fixes, the button layout, the kernel switch.
2. **xess-xmx-linux** (github.com/HHHHanasak1/xess-xmx-linux): XeSS super resolution and frame generation on the XMX
   cores, and its per-game launch options.
3. **Power control** (TDP, Arc GPU clocks, CPU EPP and turbo), built in, with per-game profiles: it replaces
   SimpleDeckyTDP on the OXP3 (see "Power (TDP, GPU, CPU)").

Modelled on ClawDeck (github.com/IHulkSmashI/ClawDeck, MIT, MSI Claw on Bazzite): some backend helpers and UI
patterns are adapted from it (credited in CREDITS.md, its licence in THIRD_PARTY_NOTICES.md). It runs on CachyOS
(Handheld Edition and desktop) and Bazzite.

## Rules

- **The plugin adds no logic of its own to what oxp3-tool does.** Every fix, state and check comes from
  `oxp3-tool <command> --json` (oxp3-tool 0.4.1 or later; an early 0.4.0 build lacks fields the plugin reads),
  run as root by the backend. The plugin is a front end. The exceptions are power control (power.py,
  powerhw.py) and the extras (extras.py: battery, fan, scheduler mode, intel_lpmd; "Extras"), which write sysfs or
  call D-Bus themselves, and the live readouts (readouts.py), which only read; none of these are jobs and no job
  ever blocks them.
- **xess-xmx-linux scripts run as the desktop user**, never as root (`runuser -u <user>`), with a minimal
  environment (`env -i` + HOME, USER, LOGNAME, PATH, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS): its 20261031
  install.sh runs `systemctl --user import-environment` with no names, which would copy Decky's variables into the
  user's session.
- **Every backend call returns a dict** `{ok: bool, error: str|null, ...}` and never raises: Decky loses the message
  of a Python exception on its way to the frontend. Answers (and get_setting's value) pass through main.py's
  `_sendable`: JSON types only, and text that is not UTF-8 (a lone surrogate from a file name) becomes "?", since
  Decky drops an answer it cannot encode and the frontend's call then never settles.
- **Nothing blocks the asyncio loop**: subprocesses and downloads run in an executor thread.
- **Long work is a job** (see Jobs): oxp3-tool apply/revert (a Limine rebuild can take minutes), xess install,
  update, uninstall, oxp3-tool update, diagnose, kernel try/keep. One job at a time; oxp3-tool also allows only one
  root run at a time (`/run/oxp3-tool.lock`), so the backend serialises every oxp3-tool call behind one lock.
- **Children get a clean environment**: Decky's PyInstaller bundle sets LD_LIBRARY_PATH (its own OpenSSL) and
  friends; main.py restores the `*_ORIG` values at import and every subprocess gets `clean_env()`.
- **HTTPS** uses the system CA bundle (or certifi when importable): Decky's Python has no CA store.
- **Root never writes through a link the user planted.** Decky gives the settings, data and log folders (and the
  home) to the user at every load. settings.json and the job files are written with `context.write_atomic`, which
  walks the folders above with `userexec.open_dir` (a symlink is followed only when root owns it and the folder it
  sits in, like `/home -> var/home` on Bazzite) and opens the last one with O_NOFOLLOW (old job files are listed,
  read and removed through that same kind of folder descriptor, never by path again); files in the home are
  created by `userexec.write_new` (O_EXCL, O_NOFOLLOW, owned by the user) or by the user (`userexec.run`,
  `user_mkdirs`); downloads go into a root-only `mkdtemp`.
- **`_uninstall` undoes nothing**: Decky runs it on every update of the plugin too. Uninstalling oxp3-tool or
  xess-xmx-linux is an explicit button.
- **One line up front, the rest in Details.** Every control and status row has a one-line `description` in plain
  words (at most about 80 characters, no acronyms, no commands, no paths). When it takes effect, risks, the
  technical names (PL1, EPP, unit names, env variables, paths) and how to fix a problem go in its **Details** modal
  (see "Frontend → Details"): the Options (☰) button opens it on any row that has it, A opens it too on a read-only
  row, and such a row's label ends with " ⓘ". Every action shows its result or its error in a row under the
  control (the error's first sentence; the full text in that row's Details).

## Layout (the repository root, shipped as `OXP3Deck/` in the zip)

```
plugin.json            name "OXP3Deck", flags ["root"], api_version 1
package.json           version = DECKY_PLUGIN_VERSION
main.py                class Plugin: one async method per frontend call, thin
py_modules/oxp3deck/
  env.py               clean_env(), restore of Decky's *_ORIG variables (adapted from ClawDeck)
  context.py           Ctx (the desktop user, Decky's folders, a fake root for tests), settings.json
  sysexec.py           run a program with clean_env(), stdin /dev/null, output streamed line by line (from pipes,
                       or from a root-only file it writes to); /proc start times of a pid
  tls.py               SSL context with the system CA bundle (adapted from ClawDeck)
  userexec.py          run as the desktop user with a minimal environment (adapted from ClawDeck)
  downloads.py         GitHub release lookup, download, safe extract (adapted from ClawDeck)
  jobs.py              background jobs: one at a time, log lines, result, state file
  oxp3tool.py          run oxp3-tool --json; find, install and update the oxp3-tool binary
  xess.py              xess-xmx-linux: state, install/update, uninstall, driver switch, system Protons
  steamlib.py          Steam libraries, app install folders, compat tool of an app, prefixes
  games.py             per-game info: XeSS DLL versions in the game folder, last-run shim logs, advice
  pe.py                a DLL's file version (VS_FIXEDFILEINFO, the rule tools/proton-hook.py uses)
  powerhw.py           power sysfs only: RAPL (MSR and MMIO), the xe GPU clock range and power profile, EPP (per core
                       type too), turbo, intel_pstate's speed cap and floor, per-core-type caps, the SoC slider, AC,
                       suspend count
  power.py             power control: profiles (power.json), the boot snapshot and run state, events, drift, conflicts,
                       the polling rate; power.active() for extras
  readouts.py          live readouts (package W, battery, CPU temperature, GPU busy and clocks, throttling, fan RPM):
                       read only, deltas between two samples (0.4)
  extras.py            battery charge limit and charge behaviour, fan mode (kernel 7.4+, ONEXPLAYER 3 only), scx_lavd
                       mode (org.scx.Loader), intel_lpmd off during games; extras.json, extras-run.json (0.4)
src/                   frontend (TypeScript, @decky/ui)
  api.ts               one `callable` per backend method; backend.ts wraps each so it never rejects
  types.ts             the answers below, as TypeScript types
  store.ts             cached answers per key, the current job and its polling
  actions.tsx          the confirm-then-start flows (apply, revert, installs, reboot)
  launchopts.ts        parse and change the managed launch-option variables (pure, tested under node)
  xessoffer.ts         what the xess install button offers (install / update / repair; release tags ordered as
                       xess.tag_key) and what its confirmation says (pure, tested under node)
  steam.ts             the running game (one shared watch: onMainAppChange), launch options through SteamClient
  power.ts             power control's serial writer and texts (pure, tested under node)
  effects.ts           "When it takes effect": the tags, the tag of every setting, pending texts (pure, node-tested)
  autolaunch.ts        automatic launch options: what to add, the record, Undo (pure, node-tested)
  copyopts.ts          "Copy launch options": the line to paste by hand, why, its texts (pure, node-tested)
  clipboard.ts         copy text in Steam's CEF: execCommand / navigator.clipboard chain (framework-free, node-tested)
  live.ts              the live readouts' line and Details texts (pure, node-tested)
  conflicts.ts         the conflicts' friendly names, one-liners, Details and Fix / Undo dialogs (pure, node-tested)
  text.ts              firstSentence and the one-line limit (pure, node-tested)
  pages/, components/  the quick panel, the full page's tabs (pages/Power.tsx), shared rows (Hint: explain,
                       explainWhen, Status, Note, Problem, WithDetails, label; confirm: confirm, showDetails;
                       Effect: Pending; ConflictRow, JobView, GameControls, PowerControls, CpuControls, LiveRows,
                       ExtrasControls, AutoLaunch, ...)
tests/                 unittest, with a stub `decky` module and fake roots; fixtures/oxp3: real oxp3-tool --json
                       output (tests/make_fixtures.py regenerates it from an OXP3-Tool-for-Bazzite checkout's
                       CLI, found next to this repository or by OXP3_TOOL_SRC); js/: node tests
                       of launchopts.ts and xessoffer.ts; test_main.py also checks that api.ts and main.py name the
                       same methods and that main.py calls the real modules' functions with arguments they take;
                       powerfake.py builds fake power sysfs trees for test_powerhw.py and test_power.py, with canned
                       `systemctl list-units` output and a SimpleDeckyTDP settings.json in fixtures/power
tools/build_zip.py     assembles OXP3Deck.zip from dist/, the backend files and vendor/oxp3-tool
tools/vendor_oxp3_tool.py  refreshes vendor/oxp3-tool (+ .sha256) from OXP3-Tool-for-Bazzite's dist/
vendor/                the oxp3-tool the zip carries as bin/oxp3-tool
third_party/           @decky/api 1.1.3's source, kept for its licence (LGPL-2.1, THIRD_PARTY_NOTICES.md); not built
```

State the plugin keeps: `DECKY_PLUGIN_SETTINGS_DIR/settings.json` (the xess keys listed under the install job,
`oxp3_online` {version, commit, checked_at} of the last online check, `oxp3_reboot_pending` {boot_id, value} from
the last status or change, and the frontend's `ui_*` keys), `DECKY_PLUGIN_RUNTIME_DIR/jobs/<id>.json` (job state
and logs, the newest 30). oxp3-tool's output files, the xess-xmx-linux scripts' output (`user-*.log`) and the
diagnose archive pass through `/run/oxp3deck` (0700, root's); oxp3-tool's that a plugin stop left behind are removed
at the next start once oxp3-tool's lock is free, a script's `user-*.log` once no xess-xmx-linux script from before the
restart runs (`xess-script.json`). Power control keeps `DECKY_PLUGIN_SETTINGS_DIR/power.json` (profiles and
options) and `/run/oxp3deck/power-run.json` (the boot snapshot, the last game, what it wrote, locked limits, an
override; for this boot only); the extras keep `DECKY_PLUGIN_SETTINGS_DIR/extras.json` (charge limit, charge
behaviour, the intel_lpmd option) and `/run/oxp3deck/extras-run.json` (what they changed this boot and what was there
before). The frontend keeps `ui_autolaunch`, `ui_autolaunch_log`, `ui_power_advanced` in settings.json. Nothing inside
the plugin folder (an update deletes it).

## Backend API (main.py)

All methods are `async def name(self, ...)` on `Plugin`, called from `src/api.ts` with `callable`. Types below are
TypeScript as seen by the frontend. Every result has `ok: boolean` and `error: string | null`.

### Overview

```ts
get_overview(): {
  ok, error,
  plugin_version: string,
  user: string, home: string,
  platform: "cachyos" | "bazzite" | null,      // from /etc/os-release
  device: { vendor: string|null, product: string|null, supported: boolean },  // DMI, ONEXPLAYER 3?
  oxp3: Oxp3Install,
  xess: XessSummary,
  job: Job | null,                              // the running job, if any
  reboot_pending: boolean,                      // from the last oxp3 status (kept in settings.json for this boot)
  do_not_reboot: string | null,                 // oxp3-tool's unfinished boot-entry rebuild (/run marker)
}
type Oxp3Install = { installed: boolean, path: string|null, version: string|null, json_ok: boolean,
                     min_version: "0.4.1", bundled_version: string|null }
type XessSummary = { installed: boolean, version: string|null, status: "ok"|"failed"|"unknown", line: string|null,
                     live: boolean, relogin_needed: boolean }
```

### oxp3-tool

```ts
oxp3_status(): { ok, error, status: Oxp3Status | null }        // oxp3-tool status --json, .status
oxp3_catalog(): { ok, error, catalog: Oxp3Catalog | null }     // oxp3-tool list --json, .catalog (cached per version)
oxp3_plan(fixes: string[], opts: ApplyOpts): { ok, error, plan: string[], log: string[] }   // apply --dry-run
oxp3_apply(fixes: string[], opts: ApplyOpts): JobStart          // apply FIX... --yes --json
oxp3_revert(fixes: string[]): JobStart                          // revert FIX... --yes --json
oxp3_kernel(): { ok, error, kernel: Oxp3Kernel | null }        // kernel --json, .kernel (Limine on CachyOS only)
oxp3_kernel_try(pkg: string): JobStart                          // kernel try PKG --yes --json
oxp3_kernel_keep(): JobStart                                    // kernel keep --yes --json
oxp3_diagnose(): JobStart                                       // diagnose -o /run/oxp3deck/... --json, then
                                                                // copied to ~/oxp3-diagnose-<time>.tar.gz (0600)
oxp3_update_check(): { ok, error, installed: string|null, bundled: string|null, online: string|null,
                       online_commit: string|null, update: "bundled"|"online"|null }
oxp3_install(source: "bundled"|"online"): JobStart              // install/update /usr/local/bin/oxp3-tool

type ApplyOpts = { home?: string, keyboard_key?: string, onex_key?: string, xbox_key?: string,
                   fps_limit?: number, min_refresh?: number, any_ssd?: boolean, no_restart?: boolean }
```

Fix ids, options and kernel packages are checked against `list --json` (button actions, the key flags, the
fps_limit / min_refresh ranges) and `kernel --json` before anything runs; a bad one answers `ok: false` and starts
no job. The fixes are always named (a plain `apply` would apply every recommended fix). oxp3-tool's output goes to
files in `/run/oxp3deck` (root only) and it runs in its own session, so a plugin reload does not cut it off; with
`--json` it prints nothing until it ends, so a job logs "still running" every 30 s and oxp3-tool's own lines at
the end. Status, list, kernel and a dry run answer `ok: false` ("busy") at once while a job's oxp3-tool run holds
the lock. The online update reads `__version__` and the dist files from one commit (the API's newest commit of the
default branch, `online_commit`; HEAD when the API does not answer), and the check is reused for an hour.

Job results (`Job.result`): apply / revert `{ok, error, rc, version, plan?, outcome}` (oxp3-tool's `outcome`:
`{ok, changed, reboot_needed, messages, errors}`; `version` is oxp3-tool's), kernel try / keep `{ok, error, rc,
version, action, kernel}`, diagnose `{ok, error, rc, path, findings}`, install `{ok, error, version, path, source,
commit}`. A refused argument or a failed run gives `{ok: false, error}` with whatever else was known. An apply or
revert whose outcome says `reboot_needed` sets `reboot_pending` at once (the next status confirms it).

`Oxp3Status`, `Oxp3Catalog` and `Oxp3Kernel` are exactly oxp3-tool's `--json` objects (`status`, `catalog`,
`kernel` keys); see oxp3_tool/cli.py `status_data`, `catalog_data` and kernel_cmd.py `describe_data`:

```ts
type Oxp3Fix = { id: string, group: "controller"|"display", level: "recommended"|"optional"|"experimental",
  title: string, summary: string, takes_effect: string,
  state: "applied"|"damaged"|"recommended"|"optional"|"experimental"|"n/a"|"reverting"|"incomplete"|"unknown",
  notes: string[], applied_at: string|null, options: Record<string, any>,
  pending: "reboot"|"inputplumber-restart"|null }
type Oxp3Status = { device: {vendor, product, bios, supported}, os: {name, platform, handheld, image, kernel},
  boot: string, secure_boot: boolean, can_change: boolean, needs_root: boolean, game_mode: boolean,
  game_mode_input: "ogui"|"steam"|null, warnings: string[], notes: string[], fixes: Oxp3Fix[],
  reboot_pending: boolean, rebuild_unfinished: string|null,
  refresh: { summary: string[], advice: string[] } | null, text: string }
type Oxp3Catalog = { fixes: {id, group, level, title, summary, details, takes_effect}[],
  button_actions: Record<string, string>,                         // action -> description
  button_keys: Record<"onex"|"keyboard"|"home"|"xbox", {label, default, stock, flag}>,
  fps_limit: {min, max, default}, min_refresh: {min, max, default} }
type Oxp3Kernel = { conf: string, kernels: {package, release, running, entry, usable, default}[],
  next_boot: {package: string|null, why: string, then: string|null}, remember_last_entry: boolean,
  trying: boolean, notes: string[] }
```

### xess-xmx-linux

```ts
xess_state(): { ok, error, xess: XessState }
xess_check_update(): { ok, error, installed: string|null, latest: string|null, update_available: boolean,
                       checked_at: number, note: string|null }    // note: e.g. "version unknown"
xess_install(): JobStart              // install, or update to the newest release (new folder; old one uninstalled),
                                      // or repair (install.sh again in the installed folder); never a downgrade
xess_uninstall(): JobStart            // uninstall.sh of the installed package (keeps the folder)
xess_set_driver(prefix: string): { ok, error, drivers: XessDriver[], output?: string[] }
                                      // tools/switch-driver.sh PREFIX
xess_shim_system_protons(): { ok, error, done: string[], failed: string[], already: string[], notes: string[] }
                                      // root: proton-cachyos-* shim
xess_remove_folder(path: string): { ok, error, removed?: string }   // an old package folder (listed in
                                      // old_folders, in the home, named xess-xmx-linux-<tag> or the plugin's own,
                                      // not a git checkout), only when nothing uses it any more and it does not
                                      // hold the only compiler (igc/)

type XessDriver = { version: string, default: boolean }
type XessState = {
  installed: boolean,                   // install.sh's files (environment file or check unit) point at package_dir
  package_dir: string|null, version: string|null,      // version = folder tag
  found_by: "env"|"check-unit"|"settings"|null,  // settings: only the plugin's record (installed is then false)
  managed: boolean,                     // installed by this plugin (else: by hand, e.g. ~/Documents/...)
  package_dir_kept: string|null,        // why xess_remove_folder would refuse package_dir once it is old, whatever
                                        // else changes (outside the home, no package files, a git checkout, a name
                                        // other than xess-xmx-linux-<tag> and not the plugin's), as the end of a
                                        // sentence after the path; the update confirmation says the user deletes it
  drivers: XessDriver[], preferred_driver: string|null,
  status: { state: "ok"|"failed"|"unknown", line: string|null, driver: string|null, notes: string[],
            date: string|null, lib: string|null, driver_info: string|null, reason: string|null,
            switched_to: string|null },  // driver-status's first line, every form session-check.sh writes
  live: boolean,                        // the user session's VK_DRIVER_FILES points at this package
  steam_running: boolean,
  relogin_needed: boolean,              // installed/updated, but Steam still runs with the old environment
  units: { check: string|null, watcher: string|null },   // UnitFileState / ActiveState ("not-found"), one
                                                          // `systemctl --user show` for both units
  system_protons: { path: string, name: string, shimmed: boolean, stock: boolean }[],  // /usr/share and
                                        // /usr/local/share steam/compatibilitytools.d/*; stock: F.stock exists
  system_protons_need_shim: boolean,    // shimmed before (xess_shim_system), and a package update undid it
  user_protons: { name: string, path: string, shimmed: boolean, hook: boolean }[],
  missing_tools: string[],              // curl, ar, tar, zstd, sha256sum, cmp, python3; "vulkaninfo (optional)"
  old_folders: string[],                // earlier package folders that can be removed after a re-login; one with a
                                        // compiler is left out while the installed package has none
  old_folders_kept: { path: string, why: string }[],   // earlier ones xess_remove_folder always refuses (why: as
                                        // package_dir_kept); the XeSS tab shows them with no Remove button
  flatpak_steam: boolean,
  latest: string|null, checked_at: number|null,   // from the last update check; latest only when it is newer
                                        // than the installed release (xess.newer; any other tag when either cannot
                                        // be ordered), or when nothing is installed
  update_available: boolean,            // latest is set and something is installed
  missing_downloads: string[],          // "igc", "xess", "ffx": the package has tools/get-<piece>.sh, not its files
                                        // (install.sh only prints a line when a download fails, and exits 0)
  repair: string|null,                  // no newer release, a known version, but install.sh should run again in
                                        // this folder, and why: a missing download, the environment file names
                                        // another folder, the driver check line is missing or for another folder
                                        // (a run cut short), the check unit is missing, the driver check failed
  script_running: string|null,          // a package script an earlier plugin process started and that still runs
  features: { fsr: boolean, alt_driver_store: boolean },   // FSR=xess (tools/fsr-fg.sh), INTC_ALT_... (20261104+)
}
```

The install job's result: `{ ok, error, tag, package_dir, previous, relogin_needed, reboot_needed, next, warnings:
string[], notes: string[], status }`, or `{ ok: true, up_to_date: true, ... }`; on an install.sh failure
`rolled_back`. The uninstall job's: `{ ok, error, package_dir, restored: string[] (system Protons given their stock
file back), warnings, relogin_needed: true, next }`. `next` is the re-login line the frontend shows under the
finished job (a reboot line, with `reboot_needed: true`, when the new driver failed its check and the fallback is
not in place). At start-up (`_main`) a job `xess-reshim` shims the system Protons again when
`system_protons_need_shim`. Its steps (xess.py): refuse while a game runs, with only Flatpak Steam, or without the
tools; the newest tag (the installed tag, or a newer installed one: up to date when `repair` has nothing to say,
else install.sh again in that folder after copying a missing `igc/` / `xess/` / `ffx/` from an old folder as below,
nothing downloaded; an installed release newer than the newest with nothing to repair is refused, nothing changed);
download into a root-only `mkdtemp` (no checksum is published); unpack as the user into
`~/.local/share/oxp3deck/xess/xess-xmx-linux-<tag>` (exec bits from the archive); copy `igc/`, `xess/`, `ffx/` from
the old package when the new release's `get-igc.sh` / `get-xess.sh` / `get-ffx.sh` is byte-identical or pins the
same downloads (IGC_TAG and NEO_TAG, the same in 20261031 and 20261104; XESS_TAG, XESS_SHA256 and LIBS; FFX_TAG and
each file's checksum); stop the shim watcher; the old `uninstall.sh`; the new `install.sh` (rolled back with the old
`install.sh` on failure); a warning per piece install.sh could not download; the stored driver
(`switch-driver.sh`); the system Protons as root; settings; when the driver check failed, `systemctl --user restart
xess-xmx-check.service` (the unit is active since boot, so a log-out would not run it again): session-check.sh then
switches to the package's other driver or points the user manager at the stock drivers, and `next` asks for a
reboot only when neither happened. Settings it keeps: `xess_package`, `xess_tag`,
`xess_old_folders`, `xess_installed_at`, `xess_uninstalled_at`, `xess_driver`, `xess_shim_system`, `xess_latest`,
`xess_checked_at`.

Where this follows the scripts rather than a simpler rule: libraries come from `steamapps/libraryfolders.vdf`, else
`config/libraryfolders.vdf` (tools/steam-libraries.sh); a system Proton's `F.stock` is written when it is missing
**or differs** from a stock `F` (install.sh's install_shim: a package update brings a new stock file), and a shim
older than the package's is replaced.

### Per game

```ts
game_info(appid: string): { ok, error, game: GameInfo }
type GameInfo = {
  appid: string, install_dir: string|null, prefix: string|null,
  compat_tool: string|null,             // Steam's CompatToolMapping for the app (null: Steam's default)
  default_compat_tool: string|null,     // CompatToolMapping "0"
  compat_tool_dir: string|null, compat_tool_system: boolean, compat_tool_hook: boolean|null,
  compat_tool_shimmed: boolean|null,    // does the Proton the game uses (its own, else Steam's default) carry the
                                        // shim? null: folder unknown, or a Proton without igdext (Proton 11.0)
  dlls: { name: string, path: string, version: string|null, kind: "xess"|"ffx", link: boolean }[],
                                        // libxess*.dll / libxell.dll and FSR 3.1+'s amd_fidelityfx_*.dll, searched
                                        // 10 folders deep (as tools/proton-hook.py), at most 20000 entries
  last_run: { trace: boolean, fallback: string|null, compile_failed: boolean, canary: boolean,
              xell_unsupported: boolean|null, logged_at: number|null } | null,
                                        // from the prefix (null: no prefix; xell_unsupported null: not logged)
  advice: string[],                     // e.g. "XeSS 2.0.1: add XESS=latest", "XeLL 1.2: frame generation may fail"
  // 0.4.x
  known_issues: GameIssue[],            // games.py KNOWN_ISSUES (below)
  fg_crash: boolean,                    // a known issue: XeSS frame generation crashes the game
  has_fg: boolean|null,                 // libxess_fg.dll in the folder (null: folder unknown or searched in part)
  prefix_checks: { driverstore_capital: boolean, driverstore_capital_shimmed: boolean|null,
                   hides_wine: boolean|null } | null,
  checks: { id, label, line, detail }[],   // short rows from prefix_checks and the last run (below)
}
// last_run also has xell_builtin ("[XeLL] Using built-in context") and fg_fullscreen (igdext_xefg.log: "Interpolation
// is not supported in fullscreen mode"), null without that log.
```

#### Known issues per game (games.py `KNOWN_ISSUES`, 0.4.x)

`{appid: ({id, fg_crash, fsr_risk, label, line, detail, source}, ...)}`; every entry names its source, `line` fits one
row (≤ 80). `fg_crash`: XeSS frame generation crashes the game; `fsr_risk`: FSR=xess / FSR_FG replace its signed
FidelityFX DLL.

| App | Issue | Source |
|---|---|---|
| 2246340 Monster Hunter Wilds | `fg_crash`, `fsr_risk`: "Frame generation crashes the game." The game has no `libxess_fg.dll` (its FG is DLSS-G / FSR 3.1), so XESS_FG has nothing to act on; FSR=xess / FSR_FG=xess replace Capcom's signed FidelityFX DLL (issue #42's crash pattern, anti-tamper suspected); XESS=latest also swaps files | owner report; xess-xmx-linux issue #42; OptiScaler wiki |
| 292030 The Witcher 3 | "Its XeLL 1.2 refuses the add-on's GPU report, so frame gen stays off": XeLL 1.2.1.13 does not check for Wine, asks the shim for GTGeneration and accepts only 1270–1276 and 1300; the shim reports 30. What to try: Proton Experimental + XESS=latest; Compatibility mode (force_vk_vendor=-1, cross-vendor path, unverified); IGDEXT_GTGEN=1300 (experimental). proton-cachyos 11.0-20261005 hides Wine from it, so XeLL 1.3 refuses the GPU there too | XeLL 1.2.1.13 disassembly; shim GpuInfo.cpp; proton-cachyos release notes |

The frontend (GameControls): each issue is a row (red while a frame generation or FSR key is set and the issue is
`fg_crash`) with its detail and source in Details. For `fg_crash`, the Frame generation dropdown reads "Crashes this
game: leave it on Game default." and choosing any number asks first ("Use it anyway", destructive); for `fsr_risk` /
`fg_crash` the FSR → XeSS dropdown asks first too. Every game's frame generation Details carry "Frame generation can
crash some games; if a game crashes, turn it off." (`FG_CRASH_LINE`). `has_fg === false` with no FSR route
(FSR / FSR_FG unset: those bring XeSS frame generation in, and XESS_FG then sets its multi-frame, fsr-frame-generation.md:36-41)
reads "This game has no XeSS frame generation." and, while XESS_FG is set, a row "No XeSS frame generation in this game".

The XeLL 1.2 advice line no longer promises XESS=latest on a Proton without the hook (it said "swaps in XeLL 1.3.2.10"
on system proton-cachyos, where the hook is missing): it says the hook is missing and to pick Proton Experimental;
with `hides_wine` it adds that XeLL 1.3 may refuse the GPU too.

#### What the plugin detects and shows (`checks`, 0.4.x)

| id | When | Row |
|---|---|---|
| `driverstore` | the prefix's system32 has a `DriverStore` spelled otherwise than `driverstore` (proton-cachyos), and its `FileRepository/igd_faux.inf_1/igdext64.dll` (case-insensitive, link resolved; read only under the home, a library or a system tool folder) is not the shim | "Second driver store in the prefix": Wine picks it, so XeSS loads the stock file. Issue #46; the fix (PR #47) is on main only. Work-around: delete that folder with the game closed, or Proton Experimental |
| `hides_wine` | `pfx/user.reg` names `HideWineExports` and the game has `libxell.dll` | "Proton hides Wine from this game": XeLL 1.3 then takes the Intel path and can refuse the GPU |
| `fullscreen` | `last_run.fg_fullscreen` | "Last run: exclusive fullscreen": pick borderless |

The XeSS tab (`xessoffer.releaseRows`): "Release older than 20261104" (its fixes: PR #43, low latency on, Mesa
26.3.0-rc3 / 26.1.2, FSR → XeSS) and, with a system Proton named *cachyos* and a release up to 20261104, "Known bug:
proton-cachyos driver store" (#46, fixed on main only). Not detectable from the backend, so only in the frame
generation Details: a gamescope frame limit (the OXP3 frame-limit key, the dynamic limiter) or Steam's caps the
generated frames too; exclusive fullscreen turns XeSS frame generation off.

Launch options are read and written by the **frontend** (`SteamClient.Apps.RegisterForAppDetails`,
`SetAppLaunchOptions`): the plugin manages only these variables before `%command%` and keeps every other token:

| Variable | Values | Meaning |
|---|---|---|
| `XESS` | `latest`, `dp4a` | Intel's newer XeSS libraries while the game runs / XeSS without XMX |
| `XESS_FG` | `2`..`4` (`5`..`8` experimental) | frame generation multiplier |
| `MESA` | `26.1`, `26.3` | which patched driver the game uses |
| `force_vk_vendor` | `-1` | hide the Intel GPU from the game (Mesa's own profile for some games) |
| `XESS_LOG` | `1` | the shim's, XeLL's and XeFG's logs in the prefix |
| `FSR` | `xess` | the game's FSR 3.1+ upscaling and frame generation on XeSS (xess-xmx-linux 20261104+) |
| `FSR_FG` | `xess`, `inject` | only FSR frame generation on XeSS; `inject` (with `FSR=xess`) adds XeSS frame generation (20261104+) |

The frontend offers `FSR` / `FSR_FG` only when the installed package is 20261104 or newer (its tag, or
`features.fsr`), or when they are set already.

Options without `%command%` are game arguments: the plugin writes `VARS %command% ARGS`, each argument as a literal
shell word (`-name (Player One)` becomes `-name '(Player' 'One)'`), since Steam runs a line with `%command%` through a
shell. The old text is split at spaces, tabs and line ends (a no-break space stays in its word); quotes group words
as before and are dropped, a backslash is an ordinary character (`C:\Games\cfg.ini` stays as it is); with an
unclosed quote every word is taken as it is. A `%command` without the closing `%` is shown as a warning.

### Jobs and misc

```ts
type JobStart = { ok, error, job: Job | null }
type Job = { id: string, kind: string, title: string, state: "running"|"done"|"failed",
             started: number, ended: number|null, log: string[], result: any, error: string|null }
job_status(id: string | null): { ok, error, job: Job | null }   // null: the running job, else the last one
job_list(): { ok, error, jobs: Job[] }                          // the last 10
reboot(): { ok, error }                                          // systemctl reboot
get_setting(key: string): any; set_setting(key: string, value: any): { ok, error }
```

Settings the frontend may read and write: `xess_driver` (a Mesa prefix such as "26.3", or null),
`xess_shim_system` (boolean) and `ui_*` keys (at most 64, each a JSON value of up to 4 KB); any other key reads as
null and is refused. `reboot()` is refused while a job runs, an oxp3-tool run holds `/run/oxp3-tool.lock` (one that
outlived a plugin restart, or one from a terminal), an xess-xmx-linux script from before a plugin restart still runs
(`xess.script_running`) or a boot-entry rebuild is unfinished. xess_set_driver,
xess_shim_system_protons and xess_remove_folder are refused while an xess job runs.

Jobs run in an executor thread, one at a time (a second start returns `ok: false`, "another task is running").
Their log is the job's own lines plus, for xess-xmx-linux scripts, the script's output as it arrives. A job's state
is written to `RUNTIME_DIR/jobs/<id>.json` when it starts, every few seconds while it logs, and when it ends; one
that was running when the plugin stopped is shown as failed ("interrupted (the plugin restarted)") at the next start,
an oxp3-tool job whose run still holds oxp3-tool's lock as "the plugin restarted while oxp3-tool was running; it may
still be running: read the status when it has ended".

A plugin stop (Decky kills the process 5 s after asking) ends the job's own steps, not the programs it started:
oxp3-tool and the xess-xmx-linux scripts (install.sh, uninstall.sh, switch-driver.sh: `userexec.run(...,
detach=True)`) run in their own session with stdout and stderr going to a new root-only file in `/run/oxp3deck`
instead of a pipe, so they never die of SIGPIPE and run to their end, EXIT traps included; the plugin follows that
file while it lives and removes it when the program ends. A file does not slow its writer down as a pipe does, so
it is read every 20 ms while nothing new is in it, emptied when a read reaches its end past 8 MB, and emptied unread
at 16 MB (a program that writes faster than its lines are logged; one line says output was skipped): `yes` peaks at
about 35 MB. Short helpers (cp, rm, mv, the unpacker, systemctl) keep
their pipes. Every program run as the user gets its own session, so a timeout kills runuser's child too, not only
runuser. While an xess-xmx-linux script runs, `/run/oxp3deck/xess-script.json` (root's, 0600, written through the
folder's descriptor) names it with runuser's pid, its /proc start time and the plugin process; it is removed when the
script ends. After a plugin restart, while that process still runs (same pid and start time), xess_install,
xess_uninstall, xess_set_driver, xess_shim_system_protons and xess_remove_folder answer `ok: false` ("an
xess-xmx-linux script from before the plugin restarted is still running (...); try again when it has ended"),
`reboot()` too, `xess_state.script_running` names it, and the start-up re-shim does not run. The record is read,
checked and removed under one lock, and removed only while it is still the one read (or written), so a thread that
finds an old record ended cannot remove the live one a job has written since.

## Frontend

- 0.4: every setting carries a "When it takes effect" tag and greyed-out controls say why ("When it takes
  effect"); the Power section gains the Live row and the new controls ("Frontend 0.4"); per-game controls gain
  automatic launch options ("Automatic launch options").
- **Quick Access panel** (short):
  - Status: device and OS line; red "Do not reboot" when a boot-entry rebuild is unfinished; "Reboot to finish"
    button when a change waits for a reboot; the running job with its last log line.
  - oxp3-tool: install/update button when missing or outdated; recommended fixes not applied yet, with "Apply
    recommended" (confirm first).
  - XeSS: status line (driver, live, re-login needed), Install / Update / Repair button (xessoffer.ts: Update only
    to a release tag newer than the installed one, from the overview's summary or a check tapped in this session;
    Repair, install.sh again for the same release, when `xess_state` says `repair`, with its reason).
  - This game (only while a game runs): XeSS options as dropdowns writing the launch options, the advice lines.
  - "More" button → full page.
- **Full page** (`/oxp3deck/<tab>`, SidebarNavigation): Fixes, Buttons, XeSS, Games, Kernel (CachyOS + Limine
  only), Updates & logs.
  - Fixes: every fix with its state, notes and takes-effect text; Apply / Revert per fix with a confirmation that
    shows the dry-run plan.
  - Buttons: one dropdown per key (actions from the catalog), the frame-limit value, "Apply layout" (applies
    `buttons`, and `xbox-key` when the Xbox key needs its helper).
  - XeSS: version, driver status, a package script from before a plugin restart that still runs (`script_running`:
    the xess buttons wait for it), default Mesa driver dropdown, Install / Update / Repair / Uninstall, system
    Protons, missing tools, downloads install.sh could not fetch (`missing_downloads`), old folders (Remove, or a
    note for one in `old_folders_kept`). The install confirmation says what the job will do: an update uninstalls the
    old package first (and says when its folder is the user's to delete: `package_dir_kept`); the default Mesa driver
    is promised back only when one was chosen in OXP3 Deck (`preferred_driver`); the system Protons get the shim as
    root. A page without `xess_state` (the quick panel, Updates) asks for it before the confirmation; when that fails
    too, the confirmation says both: the driver chosen in OXP3 Deck, else the release's, and the shim in any system
    Proton.
  - Games: the running game, or the last one; same controls as the quick panel plus the full advice and last-run
    details.
  - Kernel: installed kernels, next boot, Try (boot once) / Keep.
  - Updates & logs: oxp3-tool and xess versions with update checks, diagnose archive, the last jobs and their logs.
- **Jobs on screen** (components/JobView.tsx): the job a control started shows under that control, any other one at
  the top of the tab; once it ends, its result's lines follow the log (oxp3-tool's outcome errors and messages, the
  xess jobs' `warnings` and `notes`, diagnose's `findings`), then `next` (after an xess install whose new driver
  failed its check, a reboot instead of the log-out line, unless the result says `reboot_needed: false`), "Reboot to
  finish" for an outcome or a result with `reboot_needed`, and the diagnose archive's path.
- **A game's Proton** (components/GameControls.tsx) is described from `compat_tool_shimmed` (the shim: XeSS on the
  XMX cores) and `compat_tool_hook` (the hook: XESS=latest/dp4a, XESS_LOG, FSR); FSR choices show when the package
  is 20261104 or newer by its tag or `features.fsr`, or when they are set already.

### Details (one line up front, the rest on demand)

Steam Game Mode has no mouse hover, so `ItemProps.tooltip` never shows and is not used. `ItemProps.explainer` (Steam's
own "?" button) is typed in @decky/ui 4.16 but untested on the device; it is **not** used (it could render twice next
to ours). One mechanism, the same on every screen:

- **`showDetails(d: DetailsSpec): void`** in `components/confirm.tsx`: `showModal(<ConfirmModal bAlertDialog
  strTitle={d.title} strDescription={body} strOKButtonText="Close" onOK onCancel />)`; `body` is `d.body` then, when
  `d.lines` is set, a monospace block under `d.linesTitle` (same look as confirm's `lines`), all inside one
  `maxHeight: 60vh; overflowY: auto` box so a long body scrolls with the D-pad.
  ```ts
  export type DetailsSpec = { title: string; body: ReactNode; lines?: string[]; linesTitle?: string };
  ```
- **`<WithDetails details={DetailsSpec | undefined}>{control}</WithDetails>`** in `components/Hint.tsx`, around a
  ToggleField, SliderField, DropdownItem or ButtonItem: a `Focusable` with `onOptionsButton={() =>
  showDetails(details)}` and `onOptionsActionDescription="Details"` (gamepad events bubble from the focused control,
  as in Decky's ReorderableList), so the footer shows "☰ Details" while the control is focused and A still does the
  control's job. Without `details` it renders the child alone.
- **`label(text, details?)`** in Hint.tsx: `text` plus `INFO = " ⓘ"` when `details` is set. Every control inside
  `WithDetails` gets its label through it, so the mark means "Details here".
- **Read-only rows**: `Status`, `Note` and `Problem` take `details?: DetailsSpec`. When set: the label goes through
  `label()`, the Field gets `onActivate={() => showDetails(details)}` (A), `onOKActionDescription="Details"` and the
  same `onOptionsButton`.
- **Hint.tsx API**: `explain(does: ReactNode)` takes one sentence (the `when` and `note` arguments are removed; that
  text moves into the control's Details, so `pnpm typecheck` finds every old call). `Status.detail` is one line.
  `Note`'s children are one line (`label` + one line; the old paragraph goes into `details`). `Problem` shows
  `firstSentence(error, 100)` and puts the whole error in its Details (title "<what>: did not work").
- **`src/text.ts`** (framework-free, tested under node): `firstSentence(s, max)` (up to the first ". " / ": " after
  20 chars, else cut at a word before `max` with "…"); `MAX_LINE = 80`.
- **Details body**, always in this order, each part only when it says something: what it does → when it takes
  effect (0.4: the tag's text, then any condition) → risks / when to leave it alone → how to fix (for a problem) → "Technical:" the names (PL1, EPP, unit names,
  env variables, paths, commands) as `lines`. Technical names appear only here.
- **Problem rows with a fix**: a conflict, and the EPP/CPU boost controls while one blocks them, get the row pattern
  below ("Conflict rows").

### Conflict rows (`components/ConflictRow.tsx`, used by PowerControls and the Power tab)

For one `PowerConflict` (texts from `src/conflicts.ts`, keyed by id, with the row's `name`/`why`/`fix` as the
fallback for an id it does not know):
1. `Status` ✗ (red when kind "blocks"), label `friendlyName(id)` with " ⓘ", detail `oneLine(row)`; Details:
   `explainBody(row)` (what it is, what turning it off costs on this system, the manual way: "Do it yourself" with
   the command of `row.fix` as a line, only when it is a `sudo …` command, cut before its reason; prose guidance the
   body already says is not repeated).
2. When `row.fix_units.length` and no record: ButtonItem **"Fix for me"**, description "Turns <short name> off. You can
   undo it." → `confirm(fixConfirm(row, info.state.enabled))` → `power_fix(row.id)` (after `powerWriter.drain()`);
   its result row under it (for a "cpu" id under Energy preference / CPU boost, the "<name> is off" row with Undo
   takes the conflict row's place, also on the Power tab): ✓ "Turned off" / the Problem.
3. When `row.fixed?.came_back`: the Status detail reads "It started again: <who>" and the button reads **"Fix
   again"**; ButtonItem **"Undo"** next to it.
4. When the row is ignorable: ButtonItem **"I've handled it"** (was "I have done that"), description "Only once it no
   longer changes these settings." → `power_options({ignore})`.
5. Without `fix_units`: ButtonItem **"How to fix"** → `showDetails(explainBody(row))`.

Records whose conflict is gone are listed on the Power tab under "Turned off by OXP3 Deck": `Status` ✓ "<friendly
name> is off", detail "Turned off <date>.", and ButtonItem **"Undo: turn it back on"**, description "Re-enables what
OXP3 Deck turned off." → `confirm(undoConfirm(rec))` → `power_unfix(id)`. The quick panel shows Undo only in the row
it just fixed (until the panel closes) and points to the Power tab otherwise.

After a fix or undo: the cached `power-info` and `power-state` are replaced from the answer (`conflicts`, `fixed`,
`state`), and `power-info` reloads once more 12 s later (after the backend's +10 s recheck), so a D-Bus restart shows
as "came back" without a manual "Check again".

`src/conflicts.ts` (pure, node-tested): `friendlyName`, `oneLine`, `explainBody` (returns `{body: string[], lines:
string[]}`, the TSX turns it into a DetailsSpec), `fixConfirm`, `undoConfirm`, `cameBackText`.

| id | Friendly name | One line (up front) | Details (what turning it off costs) |
|---|---|---|---|
| `ppd` | Power Profiles | Controls energy preference and CPU boost. | Sets energy preference from the desktop's power mode. Off: the Desktop Mode power mode switch stops; CachyOS's game-performance runs games without its profile and may start it again. Technical: power-profiles-daemon.service; it writes EPP/EPB and platform_profile. |
| `tuned` | TuneD | Controls energy preference and CPU boost. | Same as Power Profiles (tuned-ppd stands in for it). Both units are needed: tuned alone keeps its profile. |
| `intel_lpmd` | Intel low-power daemon | Controls energy preference and parks CPU cores. | CachyOS turns it on for this CPU. Off: light tasks and video use a bit more battery; games are fine. It does not touch power limits. |
| `thermald` | Thermal daemon | Lowers the power limit on its own, so power control is paused. | On this CPU it rewrites the sustained limit within seconds. The CPU's own heat limit and the fan still protect the device. |
| `powerstation` | PowerStation | Also changes power limits, so power control is paused. | It powers Steam's TDP slider on Bazzite; off, that slider does nothing. Bazzite may turn it back on after an update. |
| `oxp3-tdp-sync` | TDP sync script | Also changes power limits, so power control is paused. | A community script that copies one limit into the other every 2 s; OXP3 Deck already sets both. |
| `onex3-tdp` | onex3-tdp | Also changes power limits, so power control is paused. | Another TDP script. |
| `simpledeckytdp` | SimpleDeckyTDP | Also changes power limits, so power control is paused. | Import its profiles first (Power tab), then Decky → Settings → Plugins → disable it. |
| `powercontrol` | <plugin name> | Also changes power limits, so power control is paused. | Decky → Settings → Plugins → disable it. |
| `hhd` | Handheld Daemon | Its TDP setting also changes power limits. | Turn off TDP in Handheld Daemon's settings, then "I've handled it". It may run the controller, so OXP3 Deck does not stop it. |
| `steamos-remote` | Steam's TDP slider | Steam's TDP slider can change these limits. | Quick Access → Performance: turn off "TDP limit", then "I've handled it". |
| `unknown` | Service check | Couldn't check other services. | The systemctl error; "Check again". |

### Up-front text

Labels and one-liners every screen shows (≤ 80 chars). "→ Details" is what moves into that row's Details. `<…>`
is filled in. Rows not listed keep their text.

**Quick Access panel (pages/Quick.tsx)**

| Row | Label | One line | → Details |
|---|---|---|---|
| Device status | "ONEXPLAYER 3" ✓ / "Not a ONEXPLAYER 3" ✗ | the OS name ("CachyOS Handheld Edition") | kernel, supported systems |
| Do not reboot (red) | "Do not reboot yet" | "A boot update didn't finish. Open Details before restarting." | why, the `sudo …` to run in Desktop Mode |
| Reboot to finish | "Reboot to finish" | "Some changes need a restart." | what waits; "reboots at once after you confirm" |
| Job (quick) | "<task>: running / done / failed" | "Keep the device on." while running; else the last log line | the full log, result lines, archive path |
| oxp3-tool status | "Device fixes" | "<n> fixes applied" / "Needed for controller, sleep and screen fixes" | oxp3-tool version, minimum, path, unsupported text |
| Install / Update oxp3-tool | "Install fixes tool" / "Update fixes tool" | "Takes a few seconds." | path, source, version |
| Recommended fixes (one row, not one per fix) | "Recommended fixes (<n>)" ⓘ | the titles, comma-separated | per fix: summary, takes effect |
| Apply recommended | "Apply recommended (<n>)" | "Shows what will change before anything happens." | reboot note |
| All applied | "Fixes up to date" ✓ | — | — |
| Fixes needing a look | "Fixes need attention (<n>)" | "Open the Fixes tab to repair them." | the titles |
| XeSS status | "XeSS fast mode: On / Off / Log out needed" | e.g. "Log out and back in to turn it on." | driver line, what fast mode (XMX) is |
| Install / Update / Repair XeSS | "Install XeSS fast mode" / "Update XeSS to <v>" / "Repair XeSS" | "Faster XeSS upscaling and frame generation in games." | size, repair reason, re-login |
| Check for XeSS update | "Check for XeSS update" | "Changes nothing." / the result ("Up to date") | — |
| This game | "<game name>" | "XeSS settings for this game" | "Saved in the game's Steam launch options" |
| More | "All settings" | "Profiles, fixes, buttons, XeSS and more." | — |

**Power (components/PowerControls.tsx, quick and Power tab)**

| Row | Label | One line | → Details |
|---|---|---|---|
| Live status | "<pl1> W steady · <pl2> W boost" | "<profile> · on battery / plugged in" (+ " · GPU held back by power limit" when it is) | GPU clock, throttle reasons, "off = device defaults" |
| Blocked (red) | "Power control paused" | "<friendly name> is also changing power limits." | then the conflict rows of every blocker |
| Overridden (red) | "Something changed your power limits" | "Likely <friendly name>. Fix it, then tap Take control again." | now / set values, each suspect's guidance (Steam: its "TDP limit" and "Manual GPU clock") |
| Take control again | "Take control again" | "Re-applies your settings." | "turn the other one off first, or it changes them back" |
| Locked / failed lines | "Limit capped at <n> W" / "<what> didn't apply" | "The device firmware won't allow more than <n> W." / first sentence | MSR/MMIO, "the lower of the two wins", per-id errors |
| TDP control toggle | "Power control (TDP)" | on: "Uses your profile below." / off: "Device defaults. Turn on to set power here." | re-applies after sleep, game change, charger; off and reboot restore defaults; turn it off before uninstalling OXP3 Deck |
| First-enable confirm | title "Turn on power control?" | text: "OXP3 Deck will set power limits, GPU speed and CPU boost from your profile. Nothing changes until you move a slider. Turning it off, or rebooting, restores the defaults." + "Allowed: <range>" | the old technical paragraphs as `lines` under "Technical" |
| Hardware problems | "Power control unavailable" ⓘ | first sentence | full text |
| Refused enable | "Turn off <friendly name> first" | — | conflict rows (with Fix for me) under it |
| Profile for this game | "Separate profile for <game>" | off: "Uses the default profile." / on: "Sliders edit this game's profile." | "starts as a copy of the default" |
| Sustained power | "Sustained power" | "Steady power for CPU and GPU. Higher is faster, battery shorter." | PL1, the profile and slot it edits, "saved X, runs at Y now", device default |
| Boost power | "Boost power" | "Short bursts above sustained power." | PL2, a few seconds, the maximum, never below sustained |
| GPU min clock | "GPU minimum speed" | "Raise only if one game stutters from GPU dips." | idle power cost, device default |
| GPU max clock | "GPU maximum speed" | "Lower saves battery and leaves more power for the CPU." | efficient clock, device default |
| Energy preference | "Energy preference" | "How eagerly the CPU speeds up." / blocked: "Locked by <friendly name>." | the options, governor note, EPP; when blocked: the conflict row (Fix for me) right under it |
| CPU boost | "CPU boost" | "Off saves battery in light games." / blocked: "Locked by <friendly name>." | turbo, "most games run slower without it" |
| Use firmware values | "Reset to device defaults" | "Undoes every change in this profile." | which profile, applies at once |
| A slider at null | value shown is the device's | "(device default)" replaces "(firmware value)" | — |

**Power tab (pages/Power.tsx)**, beyond PowerControls

| Row | Label | One line | → Details |
|---|---|---|---|
| Per-zone rows (merged) | "Power limits now" ⓘ | "<pl1> W steady · <pl2> W boost" (the lowest over the zones) | per interface PL1/PL2/PL4, locked marks, the AC rewrite |
| No zones | "Power limits not available" | "This system doesn't expose power limits." | RAPL, the modules `intel_rapl_msr` and `processor_thermal_rapl` |
| GPU row | "GPU <n> MHz" | "Held back by power limit" / "Running freely" | range, raw reasons |
| CPU row | "CPU" | "Energy: <x> · Boost: <on/off> · <Plugged in / On battery>" | governor |
| cpu_blocked | "Energy preference & boost: locked" | "<friendly name> controls them." | + the conflict row (Fix for me) under it |
| Per-game profiles | "Per-game profiles" | "Games with their own profile use it." | "off keeps the saved profiles" |
| Separate values on AC | "Different settings when plugged in" | "Each profile gets a second set for charging." | switch delay |
| Extended | "Allow up to <x> W when plugged in" | "Needs a 65 W or stronger charger." | rated figures, battery limit, weak charger |
| Profile dropdown | "Profile to edit" | "Active now" / "Saved; used when this game runs" | per-game off note |
| Values for | "Edit values for" | "Battery or plugged in." | "copied at the first change" |
| TDP-off note | — | "Power control is off: changes are saved for later." | — |
| New / delete profile | "New profile for <game>" / "Delete profile" | "Starts as a copy of the default." / "The game uses the default profile again." | — |
| Conflicts section | "Other power programs" | rows as above; none: "No conflicts" ✓ | — |
| Turned off by OXP3 Deck | "<friendly name> is off" ✓ | "Turned off <date>." + Undo | the recorded units |
| Check again | "Check again" | "Look for conflicting programs." | services, programs, Decky plugins |
| Firmware section | "Device defaults" ⓘ | "Restored when power control is turned off." | the boot snapshot, per-zone boot values, PL1 base power, "turn off before uninstalling" |
| GPU clock range | "GPU speed range" | "<min>–<max> MHz" | efficient clock, card, gt |
| Allowed range | "Allowed range" | "<a>–<b> W on battery, up to <c> W plugged in" | boost max, the figures' source |
| Import | "Import from SimpleDeckyTDP" | "Copies your SimpleDeckyTDP profiles." | the next steps |
| Imported / skipped | "Imported <n>" ⓘ / "Skipped <n>" ⓘ | — | the names |

**Fixes, Buttons, XeSS, Games, Kernel, Updates**: same rule. The labels and one-liners are the "Proposed label" and
"One-liner" columns of the UX audit, kept with this design's build notes:

| Screen | Row | Label | One line |
|---|---|---|---|
| Fixes | not installed | "Fixes tool not installed" | "Install it to use this page." (+ an Install button here) |
| Fixes | refresh | "Refresh" | "Changes nothing." |
| Fixes | can't change | "This system can't be changed" | "Only ONEXPLAYER 3 on Bazzite or CachyOS." |
| Fixes | each fix | "<fix title>" ✓/✗ ⓘ | "Applied" / "Recommended" / "Optional" / "Needs repair" / "Not needed" / "Reboot pending" |
| Fixes | lowest refresh rate | "Lowest refresh rate" | "Used when you tap Apply." |
| Fixes | nvme anyway | "Apply even without the problem" | "Costs a little battery during sleep." |
| Fixes | layout link | "Choose button layout" | "Choose what each key does." |
| Fixes | apply / again / revert | "Apply" / "Apply again" / "Undo this fix" | "Shows what changes first." / "Puts the original files back." |
| Buttons | status | "Custom layout active" / "Stock layout" | "Loads at next reboot" (only when pending) |
| Buttons | each key | "<key name>" ⓘ | the action's one-line description |
| Buttons | frame limit | "Frame limit for the key" | "Press again to turn it off." |
| Buttons | Xbox key | "Xbox key: tap only" ⓘ | "Holding it for Steam shortcuts won't work." |
| Buttons | restart | "Apply without reboot" | "The controller stops for a few seconds." |
| Buttons | apply | "Apply layout" | "Shows what changes first." |
| XeSS | status | "XeSS fast mode: …" | as in Quick |
| XeSS | script running | "Installer still running" | "Buttons wait until it ends." |
| XeSS | driver check | "Driver check: OK / Failed" ⓘ | failed: "Games use the slower mode." |
| XeSS | Flatpak | "Steam is a Flatpak" ✗ | "Not supported: needs Steam from system packages." |
| XeSS | missing tools | "Missing programs: <x>" | "Install them first." |
| XeSS | not downloaded | "Some parts didn't download" | "Repair downloads them." |
| XeSS | uninstall | "Uninstall" | "Log out and back in afterwards." |
| XeSS | default driver | "Default graphics driver" | "Used by every game unless it picks its own." |
| XeSS | Proton rows | "<proton name>" ✓/✗ | "XeSS fast mode ready" / "Needs the XeSS add-on" |
| XeSS | add shim | "Add XeSS to system Protons (<n>)" | "Lets games on these Protons use fast mode." |
| XeSS | lost shim | "A Proton update removed XeSS" | "Add it again above." |
| XeSS | old folders | "Old XeSS folders" | "Remove old versions to free space." |
| Games | no game | "No game yet" | "Start a game to see its XeSS settings here." |
| Games | status | "<game name>" | "Changes apply next time you start it." |
| Games | not installed | "XeSS fast mode not installed" | "These settings do nothing yet." |
| Games | typo | "Launch options typo" (+ "Fix the typo") | "Blocks the settings below." |
| Games | XESS | "XeSS version" | per option ≤ 60 chars ("Uses the game's XeSS." / "Newer XeSS for older games." / "For testing.") |
| Games | XESS_FG | "Frame generation" | "Turn on frame gen in the game and set a frame limit." |
| Games | 5x–8x | "Show 5x–8x (experimental)" | "Adds more choices above. Not supported by Intel." |
| Games | MESA | "Graphics driver" | "Only change if this game misbehaves." |
| Games | force_vk_vendor | "Compatibility mode" | "Only for games that need it; XeSS slows down." |
| Games | XESS_LOG | "Save XeSS logs" | "For bug reports; leave off otherwise." |
| Games | FSR | "FSR → XeSS" | per mode ≤ 60 chars |
| Games | Proton | "Proton: <name>" ✓/✗ | "XeSS fast mode ready" / "Needs the XeSS add-on" / "Some settings won't work" |
| Games | non-Steam | "Paste these launch options" ⓘ | "OXP3 Deck can't write them for this game." |
| Games, This game | copy | "Copy launch options" ⓘ (button) | per reason ≤ 60 chars: "Steam didn't take them. Paste them by hand." / "OXP3 Deck can't write them for this game." / "Steam didn't return them. Paste them by hand." / "Or wait: added when you quit the game." / "Includes what this game needs." / "To paste them by hand." |
| Games | last run | "Last run: fast mode used" / "slower mode" / "no logs" ⓘ | ≤ 60 chars (files and prefix move into its Details) |
| Kernel | rows | "<package>" | "Running now" / "Default" / "Can't boot" |
| Kernel | try | "Try once" | "Next restart only. Hold power to go back." |
| Kernel | keep | "Keep this kernel" | "Always boot the kernel running now." |
| Kernel | next boot | "Next boot: <x>" | "One-time try" / "Default" |
| Updates | oxp3-tool | "Fixes tool <v>" | "Up to date" / "Update available" |
| Updates | diagnose | "Save a problem report" | "Saved to your home folder. Takes up to a minute." |
| Updates | log toggle | "Show log" / "Hide log" | (none) |

Env variable names (XESS=, XESS_FG=, MESA=, FSR=, force_vk_vendor=-1, XESS_LOG=1), paths, `install.sh`, `%command%`,
Limine and InputPlumber names leave every one-liner and appear in Details as "Adds to launch options: …" or under
"Technical". Confirm dialogs: the first paragraph says what changes in plain words; the technical rest goes into
`lines` (the oxp3-tool plan, commands, paths) and stays.

## Power (TDP, GPU, CPU)

Power control built into OXP3 Deck: sustained (PL1) and boost (PL2) power limits, the Arc GPU's clock range, the CPU's
energy-performance preference (EPP) and turbo, with a default profile, per-game profiles and optional separate AC
values. It replaces SimpleDeckyTDP, which on Panther Lake writes one value to every constraint (PL1 = PL2 = PL4), only
to `intel-rapl-mmio`, cannot set the xe GPU clocks and caps the range at 40 W.

0.4 adds the CPU speed cap and floor, the CPU vs GPU balance (SoC slider), the GPU power-saving ramp, per-core-type
caps and energy preference, the polling rate and live readouts ("Power 0.4" below), and, in their own module, the
battery charge limit and behaviour, fan mode, scheduler mode and intel_lpmd pause ("Extras").

The facts this section rests on (kernel 7.2 source and measurements on the owner's OXP3, BIOS 5.09):

- Two RAPL interfaces drive the same package and the hardware enforces the **lower** of them: `intel-rapl:0` (MSR,
  PL1 25 W / PL2 52 W / PL4 160 W at boot) and `intel-rapl-mmio:0` (PL1 35 W / PL2 52 W / PL4 160 W). The GPU follows
  the MSR PL1: with only MMIO at 50 W it stays power-limited at about 33 W. Firmware rewrites the **MMIO** limits on
  every AC change (to 35/52 W). So both interfaces get the same PL1 and PL2, and they are written again after an AC
  change and a resume.
- The kernel does no range check on `power_limit_uw`: an oversized value is truncated (5000 W becomes about 904 W) and
  one below a power unit becomes 0 W. A locked limit answers EACCES (`PermissionError`, root too) on MSR; an MMIO
  write always "succeeds", so only a read-back shows it did not take.
- `constraint_N_max_power_uw` is not a ceiling: for PL1 it is the processor's base power (25 W on the OXP3), for PL2
  `MAX_POWER` (often 0), for PL4 twice that. RAPL has no `min_power_uw`.
- xe: `tile0/gt<N>/freq0/{min,max}_freq` take MHz inside `[rpn_freq, rp0_freq]` (else EINVAL; EAGAIN while the GT
  resets or resumes); the driver keeps the user's values across resets and resume. gt0 is render (`gtidle/name`
  `gt0-rc`), gt1 media (`gt1-mc`, rp0 1200 MHz). Reading `min/max/cur/act_freq` wakes the GPU; `rp*_freq` does not.
- OXP3 limits (ONEXPLAYER's own page): 35 W sustained, "up to 40 W"; its presets are 5 / 17 / 35 W. Users run 50 W on
  AC. No firmware register holds a ceiling other than the boot PL2 (52 W).

### Rules

- **Off by default.** Nothing is written to hardware until the user turns "TDP control" on, and turning it on is
  refused while another power manager is active (Conflicts).
- **Another service is changed only on "Fix for me", and can be undone.** Only after the user taps "Fix for me" on a
  conflict and confirms a dialog that says exactly what will change (the unit names and the commands) may OXP3 Deck
  **stop and disable** that conflict's systemd units, and only the units on the `FIXABLE` whitelist (Conflicts →
  Fix for me). It never masks a unit, never uninstalls a package, never edits another plugin's settings or files,
  and never acts on its own: no tick, event, enable or start-up ever runs a fix or an undo. It records what it
  changed (power.json `fixed`) and offers **Undo**, which re-enables and starts exactly what it changed. When a
  fixed unit runs again (D-Bus activation, a system update), OXP3 Deck says so and offers the fix again; it never
  repeats it by itself.
- **Write only what is ours to write**: PL1 (`long_term`) and PL2 (`short_term`) of every `package-*` zone of
  `intel-rapl` and `intel-rapl-mmio`; `min_freq` / `max_freq` and (0.4) `power_profile` (`base` / `power_saving`
  only) of the render GT; `energy_performance_preference` of every cpufreq policy; `intel_pstate/no_turbo`; (0.4)
  `intel_pstate/max_perf_pct` and `min_perf_pct`; `scaling_max_freq` of every cpufreq policy (the per-core-type
  caps); `slider_balance` and `slider_offset` of `/sys/module/processor_thermal_soc_slider/parameters`; and the
  word `balanced` into the `profile` file of the platform-profile class device named "SoC Power Slider", **only when
  that file already reads `balanced`** (rewriting it is what makes the slider take effect; "Power → New CPU and GPU
  controls"). Never PL4 (`peak_power`), never `psys`, `core`, `uncore` or `dram` zones, never a zone's `enabled`
  (writing it changes PL2's enable and clamp bits too), never `time_window_us`, never the media GT, never the
  governor, `intel_pstate/status`, `scaling_min_freq`, SMT, the legacy `/sys/firmware/acpi/platform_profile`, any
  other platform-profile handler, and never the profiles `performance`, `low-power` or `custom` (power-profiles-daemon
  owns the choice of profile; OXP3 Deck only re-asserts `balanced` while it is already chosen). The extras
  (extras.py) have their own list ("Extras → What it writes").
- **Constraints are found by name** (`constraint_N_name`), zones by their `name` file, GTs by `gtidle/name`, never by
  index.
- **Clamp before writing, read back after**: every value is clamped to the range below; every write is read back and
  compared (RAPL within 250 mW, GPU within 25 MHz, EPP and turbo exactly).
- **No rollback.** Every value OXP3 Deck can write is inside the safe range, so a partly applied profile is never
  unsafe; the answer lists what did not take, and the next apply starts from what is read then. (Rolling back can
  fail too and would undo the half that worked, e.g. MMIO when MSR is locked.)
- **A locked limit is not tried again this boot**: an EACCES marks that constraint `locked` in the run state
  (`/run/oxp3deck/power-run.json`), and the other interface is still written.
- **Refuse to fight**: when something else changes a value OXP3 Deck wrote (and no AC change or resume explains it),
  it stops writing and says so (Drift). Only a user action takes control again.
- **Limits stay on plugin unload and uninstall**: `_unload` and `_uninstall` write nothing for power.py (the
  extras' fan, scheduler and intel_lpmd changes are undone at unload: "Extras → Safety"). A plugin reload or update
  (Decky runs `_uninstall` on every update) must not drop a game's limits mid-session, and none of these values
  outlives a reboot: firmware sets RAPL, the xe driver its clock range and intel_pstate EPP and turbo afresh at boot.
  Turning **"TDP control" off** is how firmware values come back at once: it writes the boot snapshot back.
- **No blocking**: all of this runs in executor threads (`Plugin._call`, and the watch task's `run_in_executor`), under
  one `threading.RLock` in power.py around every read-decide-write. Power calls are never refused because a job runs
  (jobs touch none of these files). No shell, no `tee`, no glob (`os.scandir` only: Decky's Python lacks `glob`); every
  path goes through `ctx.sys_path()`.

### Range

`power.limits()` (all in watts; RAPL values are converted from µW, rounded down to 0.125 W):

| | Value | Why |
|---|---|---|
| PL1 min | 5 W | The OEM's lowest preset. Firmware gives no minimum, and the kernel accepts 0 W (a hung system). |
| PL1 max, OXP3, battery | min(35, fw_pl2) | ONEXPLAYER's sustained figure; above it the battery and VRM path are outside spec |
| PL1 max, OXP3, AC | min(40, fw_pl2) | ONEXPLAYER's "up to 40 W" |
| PL1 max, OXP3, AC, `extended` on | fw_pl2 | Opt-in, AC only (users run 50 W; a weak charger then flaps) |
| PL1 max, other device | max boot PL1 over the zones | Unknown hardware: never above what its firmware set |
| PL2 min / max | the profile's PL1 / fw_pl2 | Boost is never below sustained, never above the firmware's own boost |
| GPU min / max | `rpn_freq` / `rp0_freq` of the render GT | The driver's own bounds (100 / 2300 MHz); step 50 MHz in the UI |

`fw_pl2` is, on the OXP3, the constant `OXP3_PL2_W` = 52 W (the boost firmware sets on both interfaces, BIOS 5.09;
built after review: the registers can hold another tool's leftover, e.g. a PL2 of 90 W, which must not become the
ceiling); on another device the highest snapshot PL2 over the package zones. Either is further capped by a short_term
`constraint_N_max_power_uw` when that reads above 0; PL1's `max_power_uw` (base power, 25 W) is shown on the Power tab
but is not a bound. The OXP3 is recognised as in `_device` (DMI `sys_vendor` "ONE-NETBOOK", `product_name` "ONEXPLAYER
3"). Saved profiles keep what the user chose (5..100 W, 0..5000 MHz); clamping happens at apply time against the
range of that moment, so a 40 W AC profile runs at 35 W on battery when AC values are not split.

### Backend modules

Two modules, so the sysfs layer can be built and tested on its own. All functions take `ctx` first and never raise
for an expected failure (a missing file, a refused write): they put the reason in the result.

**`py_modules/oxp3deck/powerhw.py`**: sysfs only, no settings, no policy. Values in µW and MHz.

```python
WRITE_TIMEOUT_RETRIES = 3          # EAGAIN from xe: 3 tries, 0.3 s apart
RAPL_TOLERANCE_UW = 250_000
GPU_TOLERANCE_MHZ = 25
EPP_CHOICES = ("performance", "balance_performance", "balance_power", "power")   # the order shown

def _read(path: str) -> str | None        # the single reader: text stripped, None on any OSError (patched in tests)
def _write(path: str, text: str) -> None  # the single writer: os.open(path, O_WRONLY|O_NOFOLLOW|O_CLOEXEC), one
                                          # os.write of text + "\n"; raises OSError (patched in tests to fake EACCES,
                                          # EAGAIN, EINVAL or an MMIO write that is ignored)
def discover(ctx) -> dict                 # Hw, below; cheap (a few dozen small reads), never reads GPU min/max/act
def read(ctx, hw: dict, gpu: bool) -> dict   # Reading; gpu=False skips the files that wake the GPU
def apply(ctx, hw: dict, target: dict, locked: list[str]) -> dict   # ApplyResult; writes only what target names
                                          # and what differs from the value read just before; skips `locked` ids
def ac_online(ctx) -> bool | None         # AC: a "Mains" supply's online; none: a "USB" supply's online; none: any
                                          # BAT*'s status Charging/Full; nothing: None
def suspend_count(ctx) -> int | None      # /sys/power/suspend_stats/success
```

`Hw` (JSON; ids are the sysfs directory names, `<zone>/pl1` the id of one constraint):

```python
{"rapl": [{"id": "intel-rapl-mmio:0", "iface": "mmio",        # "msr" for intel-rapl:N (also a TPMI zone there)
           "path": "/sys/class/powercap/intel-rapl-mmio:0", "name": "package-0",
           "pl1": {"n": 0, "max_uw": 25000000 | None}, "pl2": {"n": 1, "max_uw": 0 | None} | None,
           "pl4": {"n": 2} | None}],                            # pl4 recorded only to show it; never written
 "gpu": {"card": "card1", "path": ".../device/tile0/gt0/freq0", "gt": "gt0", "media_gt": "gt1" | None,
         "rpn": 100, "rpe": 900, "rp0": 2300} | None,
 "cpu": {"pstate": "active" | "passive" | "off" | None, "governor": "powersave" | ... | None,
         "policies": ["policy0", ...], "epp": bool, "epp_choices": ["performance", ...], "turbo": bool},
 "ac_supply": "ADP1" | None,
 "problems": ["GPU clocks need the xe driver (card0 uses i915)", ...]}
```

Discovery details:
- RAPL: `os.scandir(/sys/class/powercap)` entries matching `^intel-rapl(-mmio)?:\d+$` (top level only, no `:M`) whose
  `name` starts with `package-`; constraints `n` in 0..5 by `constraint_n_name` (`long_term` → pl1, `short_term` →
  pl2, `peak_power` → pl4); a zone without `long_term` is skipped. Several zones of one iface are all kept and all
  written (TPMI would add `intel-rapl:N` zones named `package-N`).
- GPU: `/sys/class/drm/card<N>` (no `-` in the name) whose `device/vendor` is `0x8086` and `device/driver` links to
  `.../xe`; the first such card. GTs: `device/tile0/gt<N>/` with a `freq0/` folder; render = the one whose
  `gtidle/name` ends in `-rc`, else (no gtidle) the lowest-numbered; `media_gt` = one ending in `-mc`. `rp0`, `rpe`,
  `rpn` are read now (they do not wake the GPU). i915 or no Intel GPU: `gpu: None` and a `problems` line. No i915
  fallback (the OXP3 runs xe; i915's RP0/RPn are read-only, SimpleDeckyTDP's bug).
- CPU: `intel_pstate/status`; policies from `os.scandir(/sys/devices/system/cpu/cpufreq)` names `policy\d+`, sorted by
  number; `epp` true when policy0 has `energy_performance_preference`; `epp_choices` = `EPP_CHOICES` filtered by
  policy0's `energy_performance_available_preferences` (`default` is never offered: null means "firmware" already);
  `governor` = policy0's `scaling_governor`; `turbo` true when `intel_pstate/no_turbo` exists. (Built: `cpu` is
  None, with a `problems` line, when there are no policies and no `no_turbo`.)

`Reading`:

```python
{"rapl": {"intel-rapl:0": {"pl1_uw": 25000000, "pl2_uw": 52000000, "pl4_uw": 160000000}, ...},   # None: unreadable
 "gpu": {"min": 850, "max": 2300, "act": 1450, "cur": 1500, "reasons": ["pl1"]} | None,   # gpu=False: rp only
                                                                                          # → {"min": None, ...}
 "epp": {"policy0": "balance_performance", ...} | None, "turbo": True | None,    # turbo = not no_turbo
 "governor": "powersave" | None, "ac": True | False | None}
```

`reasons`: `freq0/throttle/reasons` split on spaces and commas, `none` → `[]`, each with a `reason_` prefix removed.

`Target` (absolute values; a missing key means "do not touch"):

```python
{"rapl": {"intel-rapl:0": {"pl1_uw": 15000000, "pl2_uw": 30000000}, "intel-rapl-mmio:0": {...}},
 "gpu": {"min": 300, "max": 1800}, "epp": "balance_power" | {"policy0": "balance_performance", ...},
 "turbo": False}
```

`apply` order and rules:
1. Read the current values (`read(gpu="gpu" in target)`).
2. RAPL, zones in the order **mmio first, then msr** (firmware rewrites MMIO; both end equal). Per zone: if the new PL1
   is above the current PL1, write PL2 then PL1, else PL1 then PL2 (PL1 ≤ PL2 at every step). A value equal to the
   current one (within tolerance) is not written. `pl2_uw` below `pl1_uw` is raised to it (powerhw's last guard;
   power.py already clamped). `PermissionError` → failed with `locked: true` and the other constraint of that zone is
   still tried; another `OSError` → failed with its strerror.
3. GPU: if the new min is above the current min, write max then min, else min then max. EINVAL → failed
   ("outside rpn..rp0"); EAGAIN → retry `WRITE_TIMEOUT_RETRIES` times, 0.3 s apart (in the executor thread).
4. EPP: refused as a whole (failed, nothing written) when the governor is `performance` ("the CPU governor is
   performance: EPP cannot change") or the value is not in `epp_choices`; else every policy whose value differs.
   (Built: the refusal applies only when some policy would change, so restoring firmware values that already read
   the same under the `performance` governor is not a failure.) EBUSY on one policy → failed for it (`epp/policyN`),
   the others go on. (Built after review: a dict target, i.e. the snapshot, may also hold a raw number "0".."255":
   intel_pstate shows an EPP that matches none of its names that way, and accepts it back. A string target, the
   user's choice, stays limited to `epp_choices`.)
5. Turbo: `no_turbo` = `0` / `1`; EPERM → failed ("firmware has turned turbo off").
6. Read everything written back (`read(gpu=...)`), compare within tolerance; a mismatch → failed
   `"did not take: reads 35 W"` (an MMIO lock, firmware, or another writer), and that id leaves `written`.
   A part the hardware lacks (no xe GPU, no EPP, no `no_turbo`) named in the target → failed `gpu` / `epp` / `turbo`.
7. (Built after review.) PL4 is never written, but a zone of the target whose read-back PL4 (above 0) is below its
   PL2 gets a failed item `<zone>/pl4`: "peak limit 15 W is below boost (set by another tool); reboot to restore"
   (Handheld Daemon scales PL4 with its TDP; SimpleDeckyTDP's `constraint_*` write sets it on MSR-only machines). It
   is a warning: power.py does not count it when deciding that an apply failed as a whole.

`ApplyResult`:

```python
{"ok": bool,                         # nothing failed
 "error": str | None,                # the failed items joined, first 3
 "written": ["intel-rapl-mmio:0/pl2", "intel-rapl-mmio:0/pl1", "gpu/max", "epp", "turbo", ...],   # in write order
 "failed": [{"id": "intel-rapl:0/pl1", "error": "locked by firmware", "locked": True}, ...],
 "reading": Reading}                 # after the writes
```

**`py_modules/oxp3deck/power.py`**: profiles, settings, run state, conflicts, events, drift. Units in its answers are
W and MHz. Its state is one `_Power` object per `ctx.settings_dir` (a module dict, so each test's temporary folder
gets a fresh one), every public function takes the module `threading.RLock`.

```python
MIN_W = 5
OXP3_BATTERY_W, OXP3_AC_W = 35, 40
MAX_PROFILES = 500
TICK_S = 2                       # main.py's watch loop period
AC_DEBOUNCE_S, RESUME_DELAY_S, RESUME_VERIFY_S, GRACE_S = 2, 3, 10, 20
CONFLICT_RECHECK_S = 60

def info(ctx, refresh: bool) -> dict            # PowerInfoRes; refresh=True re-runs the conflict check now
def state(ctx) -> dict                          # PowerStateRes; reads the GPU too (only called while a panel shows)
def enable(ctx, on: bool) -> dict               # PowerChangeRes
def options(ctx, opts: dict) -> dict            # PowerChangeRes
def set_values(ctx, key: str, slot: str, values: dict) -> dict   # PowerChangeRes
def profile(ctx, appid: str, name, on: bool) -> dict             # PowerChangeRes
def game(ctx, appid) -> dict                    # PowerChangeRes
def take_control(ctx) -> dict                   # PowerChangeRes
def import_sdtdp(ctx) -> dict                   # PowerImportRes
def tick(ctx) -> dict                           # {ok, error, did: "idle"|"applied"|"overridden"|"blocked"|"nothing"}
def summary(ctx) -> dict                        # PowerSummary, for get_overview (no GPU read, no systemctl)
def limits(ctx, hw: dict, ac: bool | None) -> dict   # PowerRange (exported for tests and info)
def conflicts(ctx) -> list[dict]                # PowerConflict[], runs systemctl once (cached CONFLICT_RECHECK_S)
```

What every changing call does, in this order, under the lock: validate (bad argument → `{ok: false, error}`, nothing
saved); save `power.json`; if the change concerns the active profile (or is enable / take_control / game), resolve
the active values (Profiles) and apply (built after review: in a new process, before the first tick, a call that
would write runs the conflict check first, so nothing is written, or restored by "off", over a blocker); answer `{ok, error, state, applied}` where `ok` is false only for a refused
call or when the apply failed as a whole (an apply with some `failed` items is `ok: true`, `applied.failed` lists
them, and the UI shows them).

Before the first write of a boot, power.py takes the **boot snapshot** (the values read then: every zone's PL1/PL2, the
GPU min/max, every policy's EPP, turbo) into the run state. It is the "firmware" value of every null field, and what
"off" writes back. It is never retaken in the same boot (a plugin restart reads it from the run file). It holds the
values **when TDP control first wrote this boot**, so another tool's leftovers can be in it (on the owner's device
SimpleDeckyTDP left MMIO at 35/35 W while MSR read 25/52 W); the UI says so. Built after review: firmware sets one
PL2 on both interfaces, so the snapshot stores the highest PL2 over the zones for every zone that has one (52 W
there, not the 35 W leftover).

Apply = resolve the active profile → values (W/MHz, nulls) → clamp to `limits(ac)` → `Target` (null → the snapshot's
value for that zone/GT/policy; PL1 and PL2 with a value go to **every** zone; PL2 null = each zone's snapshot PL2, but
never below the new PL1 and never above `pl2_max`) → `powerhw.apply(target, locked)` → store `ours` = the read-back of every id written or
already equal, add newly locked ids to `locked`, save the run state.

### Profiles and settings

`DECKY_PLUGIN_SETTINGS_DIR/power.json`, a second `context.Settings` file (settings.json keeps the oxp3/xess/ui keys;
profiles can be hundreds and the backend validates them). Each change is one `Settings.replace()` (built: a small
addition to context.Settings, `update()` without keeping the old keys, so an unknown key is dropped at the next
write); the frontend's writer sends at most one change at a time (Frontend), so no backend debounce is needed.

```json
{"version": 1,
 "enabled": false, "per_game": true, "split_ac": false, "extended": false, "ignore": [],
 "fixed": {},
 "profiles": {
   "default": {"name": null, "main": {"pl1_w": null, "pl2_w": null, "gpu_min_mhz": null, "gpu_max_mhz": null,
                                       "epp": null, "turbo": null}, "ac": null},
   "1091500": {"name": "Cyberpunk 2077", "main": {"pl1_w": 15, "pl2_w": 25, "...": null}, "ac": {"pl1_w": 30, "...": null}}}}
```

- **Migration-free defaults**: a missing file, key or field reads as the defaults above (`enabled` false, `per_game`
  true, `split_ac` false, `extended` false, `ignore` [], `default` all null, `ac` null). An unknown key is dropped at
  the next write; a field of the wrong type or out of the stored bounds reads as null (one log line); a profile key
  that is not `default` or `^\d{1,10}$` is dropped; a newer `version` is read the same way (fields this code knows),
  never refused. Bad JSON starts from the defaults (Settings already does that).
- `PowerValues` fields: `pl1_w`, `pl2_w` integers 5..100; `gpu_min_mhz`, `gpu_max_mhz` integers 0..5000 (multiples of
  50 are not required); `epp` one of `EPP_CHOICES`; `turbo` boolean. **null = the firmware's value** (the boot
  snapshot). `default` all null is "stock": enabling changes nothing until a value is set.
- **Active profile**: key = the running game's appid when `per_game` and `profiles[appid]` exists, else `default`;
  slot = `ac` when `split_ac` and AC is online and that profile's `ac` is not null, else `main`. Fields of a game
  profile are used as they are (a game profile is a full copy, no field-wise fallback to default: what the Power tab
  shows is what runs).
- `set_values(key, "ac", ...)` on a profile whose `ac` is null first copies `main` into it. `set_values` merges: a
  field present in `values` replaces (null included), absent fields stay. A key not in `profiles` (other than
  `default`) is refused: profiles are created with `profile(appid, name, True)`, which copies `default` (main and ac)
  and stores `name` (≤ 128 chars); `profile(appid, None, False)` deletes; `default` cannot be deleted. More than
  `MAX_PROFILES` → refused.
- `fixed`: what Fix for me changed, written only by `fix()` and `unfix()` (never by `options()`); its format and
  checks are under "Conflicts → Fix for me, Undo".
- `options(opts)`: `{per_game?: bool, split_ac?: bool, extended?: bool, ignore?: string[]}`; `ignore` only takes ids
  of conflicts whose `ignorable` is true. `enabled` changes only through `enable()`.

**Run state** `/run/oxp3deck/power-run.json` (root's, 0600, `context.write_atomic` into `sysexec.run_dir(ctx)`;
ignored when its `boot_id` is not this boot's):

```python
{"boot_id": str, "snapshot": {"taken_at": float, "rapl": {zone: {"pl1_uw", "pl2_uw"}}, "gpu": {"min", "max"} | None,
                              "epp": {policy: str} | None, "turbo": bool | None} | None,
 "app": str | None,                      # the last game power_game reported (survives a plugin restart)
 "ours": {"intel-rapl:0/pl1": 15000000, "gpu/min": 300, "epp": "balance_power", "turbo": False, ...},
 "locked": ["intel-rapl:0/pl1"],
 "overridden": Overridden | None,
 "suspend_count": int | None}
```

### Events: game, AC, resume

- **Game** comes from the frontend only (Steam knows it): `power_game(appid | null)` whenever the main running app
  changes, and once at plugin load. The backend stores it in the run state; if the active key or slot changes, it
  applies (not while overridden or blocked).
- **AC and resume are detected by the backend** (one source of truth, also in Desktop Mode and when Steam renames an
  event): main.py's watch task calls `power.tick(ctx)` every `TICK_S` in the executor. `tick` (cheap: no GPU read,
  about 10 small sysfs reads):
  1. disabled → remember `suspend_count`, the AC state and the clock gap, answer `idle`.
  2. **Resume**: `suspend_count()` went up, or `CLOCK_BOOTTIME − CLOCK_MONOTONIC` (`time.clock_gettime`) grew by more
     than 2 s since the last tick (s2idle without stats, or no stats file) → apply at +`RESUME_DELAY_S` (the kernel's
     RAPL restore and GuC start are done; xe EAGAIN is over), verify at +`RESUME_VERIFY_S`, grace until +`GRACE_S`.
  3. **AC**: `ac_online()` differs from the last tick → apply at +`AC_DEBOUNCE_S` after the **last** change (a
     flapping charger: 13 changes in 4 minutes were seen gives one apply once it settles), grace until +`GRACE_S` after
     it.
  4. A due apply → apply (after resume/AC the run state's `ours` is the reference; not while overridden or blocked).
  5. Otherwise the **drift check** (below).
  6. Every `CONFLICT_RECHECK_S`, and once when `recheck_at` (set by fix/unfix, +10 s) is due: the conflict check; a non-ignored blocker that appears while enabled → `blocked`.
     (Built: this runs before steps 4 and 5, so a blocker stops the apply of the same tick; once a later check finds
     no blocker, `blocked` clears and the active profile is applied at once, since the other manager has left its
     own values.)
  - Built: the "verify at +`RESUME_VERIFY_S`" is the drift check of every tick inside the grace window (no drift check
    runs while an apply is due, so a debounce is not cut short).
- First tick after the plugin starts (enabled, not blocked): if the hardware does not match the active profile
  (`app` from the run state, else default), apply. This is the boot apply; after a plugin reload it usually finds
  everything already in place and writes nothing.

### Drift (refusing to fight)

`ours` is what the last apply read back. The drift check compares the RAPL ids, `epp` (policy0) and `turbo` of `ours`
with a fresh `read(gpu=False)`; `state()` (only while a panel shows) also compares `gpu/min` and `gpu/max`.

- A difference **inside a grace window** (after an AC change or a resume; firmware resets MMIO "a little later") →
  apply again, at most 3 times per window.
- Any other difference (built: seen by tick on two ticks in a row, so a firmware MMIO reset that shows a tick
  before the AC `online` file changes is not taken for a fight; `state()`'s GPU check flags at once) →
  `overridden = {what: "intel-rapl:0/pl1", ours: "15 W", now: "35 W", since: time,
  suspects: [...]}`; from then on nothing is written automatically (no AC,
  resume, game or tick apply) until the user acts: `take_control()`, `set_values()` on the active profile, or
  `enable(true)` clear it and apply. If the same drift comes back, it is flagged again; OXP3 Deck never re-writes in a
  loop.
- Built after review, before any of that: the conflict check runs again at once (the cached one can be a minute old).
  A blocker found now sets `blocked` (tick answers "blocked"; writes resume by themselves once it is gone), not
  `overridden`. A drift of `epp` or `turbo` while a "cpu" conflict is now active drops `epp` and `turbo` from `ours`
  (they are left to it, as `cpu_blocked` says) and answers "nothing": power limits and GPU clocks go on.
- 0.4.x (owner report "CPU power settings don't seem to affect anything"): a drift of a CPU field group (`epp`,
  `turbo`, `cpu_pct`, `cpu_caps`, `soc`) by an **ignored** "cpu" conflict that sets that group (`FIELD_BLOCKERS`:
  power-profiles-daemon rewrites EPP on a power mode or charger change) is no longer an override that stops every
  write, power limits included: that group leaves `ours`, `p.yielded[group] = [ids]` (in memory) and the drift answers
  "nothing". `state.yielded` lists those groups; the status rows show "Left to another program" ("Energy preference
  left to Power Profiles.") with Details. The next apply that writes the group (a slider change, an event) takes it
  back. A drift by anything else, or of a group the ignored program does not set, is an override as before.
- `suspects`: for a RAPL or `gpu/*` item the active "blocks" conflicts (ignored ones too), for `epp` / `turbo` the
  "cpu" ones; none → `["steam"]`.
- The UI shows the red line "Something else changed the power limits (now 35 W, OXP3 Deck set 15 W). Likely: <names>."
  with the guidance of each suspect and a "Take control again" button. "steam" reads: "Steam's own Performance
  settings: in Quick Access → Performance, turn off "TDP limit" and "Manual GPU clock"."

### Conflicts

`conflicts(ctx)` runs `systemctl list-units --all --type=service --plain --no-legend --no-pager` once through
`sysexec.run` (timeout 10 s), takes the first column and the ACTIVE column (`active`/`activating`/`reloading` =
active; `_units` keeps every listed unit with its LOAD column and active flag, so a loaded but inactive unit is
known too, and a `not-found` one is not offered), reads
`/proc/*/comm` for programs started without systemd, and looks at Decky's plugins: each
`<homebrew>/plugins/*/plugin.json`'s `name` (`homebrew` = the folder two above `ctx.settings_dir`, read with
`context.read_small`), enabled unless it is in `<homebrew>/settings/loader.json`'s `disabled_plugins` list.

| id | Detected by | kind | ignorable | Fix for me (`FIXABLE` units) | Guidance (`fix`, shown in Details as "Do it yourself") |
|---|---|---|---|---|---|
| `simpledeckytdp` | Decky plugin "SimpleDeckyTDP", enabled | blocks | no | no (a plugin) | Decky → Settings → Plugins: disable or uninstall SimpleDeckyTDP (Power tab → Import first) |
| `powercontrol` | Decky plugin "PowerControl" or "PowerTools", enabled | blocks | no | no (a plugin) | same, for that plugin |
| `powerstation` | `powerstation.service` active, or comm `powerstation` | blocks | no | `powerstation.service` | `sudo systemctl disable --now powerstation.service`. On Bazzite, Steam's TDP slider uses it, and Bazzite's hardware setup turns it back on after a system update |
| `thermald` | `thermald.service` active, or comm `thermald` | blocks | no | `thermald.service` | `sudo systemctl disable --now thermald.service`: on this CPU it rewrites the sustained limit within seconds. The CPU's own heat limit and the fan curve still protect the device |
| `hhd` | `hhd@*.service` / `hhd.service` / `hhd_local@*.service` active, or comm `hhd` | blocks | **yes** | no (it may run the controller) | turn off TDP control in Handheld Daemon's settings, then "I've handled it" (adds it to `ignore`) |
| `oxp3-tdp-sync` | `oxp3-tdp-sync.service` active | blocks | no | `oxp3-tdp-sync.service` | `sudo systemctl disable --now oxp3-tdp-sync.service` (it copies MMIO PL1 into MSR every 2 s; OXP3 Deck writes both) |
| `onex3-tdp` | `onex3-tdp.service` active | blocks | no | `onex3-tdp.service` | `sudo systemctl disable --now onex3-tdp.service` |
| `steamos-remote` | a file in `/etc/steamos-manager/remotes.d/` or `/usr/share/steamos-manager/remotes.d/` containing `TdpLimit1` | blocks | yes | no (a file, often read-only) | Steam's TDP slider writes through it: turn Steam's "TDP limit" off in Quick Access → Performance, then "I've handled it" (no "remove the file": under `/usr/share` it cannot be) |
| `ppd` | `power-profiles-daemon.service` active | cpu | yes | `power-profiles-daemon.service` | `sudo systemctl disable --now power-profiles-daemon.service` |
| `tuned` | `tuned.service` or `tuned-ppd.service` active | cpu | yes | `tuned-ppd.service`, `tuned.service` | `sudo systemctl disable --now tuned-ppd.service tuned.service` |
| `intel_lpmd` | `intel_lpmd.service` active | cpu | yes | `intel_lpmd.service` | `sudo systemctl disable --now intel_lpmd.service` (CachyOS enables it on this CPU; it sets EPP and parks cores, not the power limits) |

- **blocks**: `enable(true)` answers `{ok: false, error: "another power manager is active: PowerStation", state,
  conflicts}` and writes nothing; one appearing while enabled sets `state.blocked` and writes stop (nothing is
  restored: the other manager is in charge now). An ignored ignorable one does not block.
- **cpu**: power limits and GPU work; EPP and turbo are not written unless the id is in `ignore`. `state.cpu_blocked`
  is the short text "<name> controls energy preference and CPU boost" and `state.cpu_blocked_by` the ids, so the EPP
  and CPU boost controls show it and put that conflict's "Fix for me" right under them. (The `why` of `ppd` no longer
  says "turbo": power-profiles-daemon 0.30 writes EPP/EPB and `platform_profile`; turbo stays left to it only because
  OXP3 Deck does not split the two.)
- Each answer row: `{id, name, kind, ignorable, ignored, why, fix, fix_units, fix_plan, fixed}` (`fix_units`: the
  `FIXABLE` units of this id that systemd has loaded now, `[]` when Fix for me is not offered; `fix_plan`:
  `{disable, stop}`, the units fix would disable (`UnitFileState` enabled, one `show` per unit at the scan) and stop
  (running) now, for the confirm dialog, or null when not offered or `show` cannot tell; `fixed`: the record below, or
  null); only active ones are listed. A failing `systemctl` gives one row `{id: "unknown", kind: "suspect", ...}`
  ("could not list services: ...") that blocks nothing; Fix for me and Undo are then refused ("could not list
  services").
- Built with this: `_UNITS["hhd"]` also matches `hhd_local@*.service`; powerhw's "no RAPL power limits" problem names
  the real modules, `intel_rapl_msr` and `processor_thermal_rapl` (not `intel_rapl_mmio`, which does not exist).

#### Fix for me, Undo

`FIXABLE` in power.py is the whitelist, a constant: `{"powerstation": ("powerstation.service",), "thermald":
("thermald.service",), "oxp3-tdp-sync": ("oxp3-tdp-sync.service",), "onex3-tdp": ("onex3-tdp.service",), "ppd":
("power-profiles-daemon.service",), "tuned": ("tuned-ppd.service", "tuned.service"), "intel_lpmd":
("intel_lpmd.service",)}`. No unit name ever comes from the frontend or from a file: the frontend sends a conflict
id; the record's units are checked against `FIXABLE[id]` when read.

**`fix(ctx, cid)`** (`power_fix`), under `_LOCK`, in the executor (it is not a job; at most 2 systemctl runs of 30 s):
1. `cid` must be a str key of `FIXABLE`, else `{ok: false, error: "power_fix: <cid> cannot be fixed by OXP3 Deck"}`.
   `_rows(force=True)`: the conflict must be active now (`"<name> is not running"` otherwise) and systemctl must
   have answered.
2. For each unit of `FIXABLE[cid]` that systemd has loaded: `systemctl show --property=LoadState,UnitFileState,
   ActiveState -- <unit>` (`Key=Value` lines). Skip `LoadState` other than `loaded` (not-found, masked: nothing to
   do). Record `{unit, was_enabled: UnitFileState, was_active: ActiveState in (active, activating, reloading)}`.
   When a record for `cid` already exists (Fix again after it came back), each unit keeps its earlier `was_enabled`
   (the state before OXP3 Deck first touched it) unless it is `enabled` now (something enabled it again and this fix
   disables it, so Undo must enable it); `was_active` becomes true if either says so. The record's other units stay
   in it only while `show` still reads them `loaded` (an uninstalled or masked one is dropped).
3. Save the record to power.json **before** running anything (`fixed[cid] = {at: time.time(), boot_id, units}`), so a
   crash half-way still leaves an Undo.
4. `systemctl --no-ask-password disable -- <units whose UnitFileState is enabled>` (never a static, indirect,
   generated or alias unit: there is nothing to disable), then `systemctl --no-ask-password stop -- <units that
   are active>`. Each through `sysexec.run` (clean env, stdin /dev/null, no shell, argv list), timeout 30 s, with
   the absolute path `sysexec.which("systemctl") or "/usr/bin/systemctl"`.
5. Re-read each unit (`show` again) for the answer's steps; `_rows(force=True)`; `_update_blocked`, and when it
   cleared, `apply_at = now`; for a "cpu" id, when `_may_write`, `_apply` at once (EPP and turbo are ours again).
   `p.recheck_at = now + FIX_RECHECK_S` (10 s): tick checks the conflicts again then (step 6 of tick also runs when
   `recheck_at` is due), which catches a D-Bus restart.
6. intel_lpmd only: read `/sys/devices/system/cpu/intel_pstate/max_perf_pct`; below 100 adds the note "Intel's
   low-power daemon left the CPU's top speed at N %; a reboot restores it" (OXP3 Deck does not write it).
7. Answer `PowerFixRes`: `ok` true when every command exited 0 and the conflict is gone; `steps` per command; `notes`;
   `state`; `conflicts` (the fresh rows); `fixed` (all records). A failed command: `ok: false`, `error` = its last
   stderr line ("<unit>: <text>"), the record stays (Undo still works for what did change).

**`unfix(ctx, cid)`** (`power_unfix`): `cid` must be a `FIXABLE` key with a record. Each recorded unit (checked
against `FIXABLE[cid]`) is `show`n first: one whose `LoadState` is not `loaded` (uninstalled, or masked by the user)
is dropped from the record with the note "<unit> is no longer installed (or is masked); nothing to turn back on", so
the record can always be cleared. Then, for the rest: `systemctl --no-ask-password enable -- <units whose
was_enabled is "enabled">`, then `systemctl --no-ask-password start -- <units with was_active>`. Nothing else: a
unit that was static or disabled is never enabled, one that was not running is not started. A unit whose command
succeeded leaves the record; the record goes when it is empty. Then `_rows(force=True)` and `_update_blocked`: the
conflict is back, so a "blocks" id blocks again (nothing is restored, as for any blocker) and a "cpu" id leaves EPP
and turbo to it again. Answer `PowerFixRes` like fix.

**Came back**: a row whose id has a record gets `fixed` with `came_back: true` (it is running again although OXP3
Deck turned it off). The UI says who most likely did it (`ppd`, `tuned`: "the desktop's power mode switch or a game
launcher started it again"; `powerstation`: "a Bazzite update turned it back on"; others: "something started it
again") and offers "Fix again" (the same confirm) and Undo. A record whose units all run again and are enabled again
(the user or the system turned them back on) is Undo's no-op case: Undo runs the same commands (harmless) and drops
the record.

**Known limit, said in the dialog**: power-profiles-daemon, tuned-ppd, thermald and intel_lpmd are D-Bus
activated; a disabled unit still starts when a program asks for it (KDE's power applet, `powerprofilesctl`,
CachyOS's `game-performance`). Only `mask` would stop that, and OXP3 Deck does not mask. So the ppd and tuned
dialogs say "It may start again when the desktop or a game launcher asks for it; OXP3 Deck will tell you."

**Records** (power.json `fixed`, survives a reboot so Undo works after one): `{"ppd": {"at": 1730800000.0,
"boot_id": "…", "units": [{"unit": "power-profiles-daemon.service", "was_enabled": "enabled", "was_active":
true}]}}`. `_norm_data` keeps only ids in `FIXABLE`, units in `FIXABLE[id]` (deduplicated), `was_enabled` a str of
at most 32 chars, `was_active` a bool, `at` a number; anything else is dropped (power.json sits in a folder the user
owns, so a planted record can at most enable and start a whitelisted unit). Missing = `{}`.

Not offered (guidance only, in Details): the Decky plugins (Decky keeps loader.json in memory and would overwrite an
edit by root; its `disablePlugin` route is not public API), hhd (stopping it can stop the controller), the steamos
remote and Steam's own sliders, a locked limit, PL4 left low by another tool (reboot), an MMIO write that did not
take, missing RAPL modules (no `modprobe`), no xe driver (Fixes tab), the `performance` governor (OXP3 Deck never
writes the governor).

Built (backend): `fix` also refuses a conflict found only by its process name (`fix_units` empty: "<name> was not
started by systemd: OXP3 Deck cannot turn it off"; when its unit is masked: "<name> is masked; OXP3 Deck does not
unmask services") and one whose listed units all `show` as not loaded; a failing
`show` or a power.json that cannot be saved refuses with nothing run. A record keeps an earlier unit that is no longer
in the listing while `show` reads it `loaded`. `ok` is false with "<name> is still running" when every command exited 0 but the conflict is still there (a
D-Bus restart at once); the row then has `fixed.came_back`. Each step's `ok` needs its command's exit 0 and the
re-read (`UnitFileState` no longer `enabled` after disable, `ActiveState` not active after stop). `unfix` writes
nothing (nothing becomes OXP3 Deck's); its record keeps only the units whose command failed. `recheck_at` is set
only while TDP control is on (a disabled tick is idle). `cpu_blocked` reads "<name> controls energy preference and
CPU boost"; the steamos remote's file path moved from `fix` into `why`. Tests: `tests/test_power.py` `FixTest`
with a stateful fake systemctl (`powerfake.Systemctl`).

**Dialog texts** (`src/conflicts.ts`, `fixConfirm(row, powerOn)`; title, text, `lines` = the commands with
`linesTitle` "Commands (run as root):", ok "Turn it off"). The text starts with a lead built from the row's
`fix_plan`, so it says exactly what runs: "OXP3 Deck will stop <who> and keep it from starting at boot." (both), "OXP3
Deck will stop <who>. It is not set to start at boot, so nothing else changes." (stop only), "OXP3 Deck will keep
<who> from starting at boot. It is not running now." (disable only); the `lines` hold only those commands (without
a plan: both, for every offered unit). Then "Nothing is uninstalled." ("Nothing is deleted." for the scripts); for a
"cpu" id while power control is on, "Then OXP3 Deck can set energy preference and CPU boost."; then the rest below;
then "Undo turns it back on."

| id | Title | <who> | Rest |
|---|---|---|---|
| `ppd` | Turn off Power Profiles? | power-profiles-daemon | The power mode switch in Desktop Mode stops working. It may start again when the desktop or a game launcher asks for it; OXP3 Deck will tell you. |
| `tuned` | Turn off TuneD? | TuneD (tuned-ppd and tuned) ("them") | The power mode switch in Desktop Mode stops working. It may start again when the desktop asks for it; OXP3 Deck will tell you. |
| `intel_lpmd` | Turn off Intel's low-power daemon? | intel_lpmd | Light tasks and video may use a bit more battery; games are not affected. |
| `thermald` | Turn off the thermal daemon? | thermald | It lowers the power limit on its own within seconds, so OXP3 Deck cannot hold yours. The CPU's own heat limit and the fan still protect the device; the case may get warmer at high power. |
| `powerstation` | Turn off PowerStation? | PowerStation | Steam's own TDP slider stops working; OXP3 Deck's replaces it. On Bazzite, a system update may turn it back on; OXP3 Deck will tell you. |
| `oxp3-tdp-sync`, `onex3-tdp` | Turn off <name>? | <name> | OXP3 Deck already sets these limits. |

Undo confirm: title "Turn <name> back on?", text "OXP3 Deck turns back on what it turned off (<date>). Then <name>
controls <energy preference and CPU boost | the power limits> again.", lines the enable/start commands, ok "Turn it
back on". The Undo row's Details: "OXP3 Deck turned it off (<date>)." (`when()` gives only the time for today).

### main.py

```python
power = _load("power")                       # next to oxp3tool, xess, games (powerhw is imported by power)
```

Every method goes through `self._call`; calls are written as `_mod("power").fn(self.ctx, ...)` so
`test_main_calls_the_real_modules_with_their_signatures` checks them.

```python
async def power_info(self, refresh=False)            # _mod("power").info(self.ctx, bool(refresh))
async def power_state(self)                          # _mod("power").state(self.ctx)
async def power_enable(self, on)                     # _mod("power").enable(self.ctx, on)
async def power_options(self, opts)                  # _mod("power").options(self.ctx, opts)
async def power_set(self, key, slot, values)         # _mod("power").set_values(self.ctx, key, slot, values)
async def power_profile(self, appid, name, on)       # _mod("power").profile(self.ctx, appid, name, on)
async def power_game(self, appid)                    # _mod("power").game(self.ctx, appid)
async def power_take_control(self)                   # _mod("power").take_control(self.ctx)
async def power_import_sdtdp(self)                   # _mod("power").import_sdtdp(self.ctx)
async def power_fix(self, cid)                       # _mod("power").fix(self.ctx, cid)
async def power_unfix(self, cid)                     # _mod("power").unfix(self.ctx, cid)
```

- `_main`: after the reshim check, `self._watch = asyncio.get_running_loop().create_task(self._power_watch())`
  (`_main` itself returns; `self._watch = None` in `__init__`).
- `_power_watch`: `while True: await asyncio.sleep(POWER_TICK_S)` (a main.py constant, 2; a test keeps it equal to
  `power.TICK_S`) then `run_in_executor(None, _mod("power").tick, self.ctx)`; any exception is logged (the same text at most once in a row) and the loop goes on; `Unavailable` (the
  module did not load) ends the loop.
- `_unload`: `self._watch.cancel()` when set; nothing else (limits stay). `_uninstall`: unchanged.
- `_overview` gets `"power": part("power", lambda: _mod("power").summary(ctx), None)`.

### Answers (types.ts)

```ts
export type Epp = "performance" | "balance_performance" | "balance_power" | "power";
export type PowerValues = {
  pl1_w: number | null; pl2_w: number | null; gpu_min_mhz: number | null; gpu_max_mhz: number | null;
  epp: Epp | null; turbo: boolean | null;              // null: the firmware's value
};
export type PowerProfile = { name: string | null; main: PowerValues; ac: PowerValues | null };
export type PowerOptions = { per_game: boolean; split_ac: boolean; extended: boolean; ignore: string[] };
export type PowerRange = {
  pl1_min: number; pl1_max: number; pl2_max: number;    // for the AC state now (W)
  pl1_max_battery: number; pl1_max_ac: number; extended_max: number | null;   // extended_max: OXP3 only
  gpu_min: number | null; gpu_max: number | null; gpu_efficient: number | null;   // rpn, rp0, rpe (MHz)
  spec: "oxp3" | "firmware";
};
export type PowerZone = {
  id: string; iface: "msr" | "mmio"; name: string;
  pl1_w: number | null; pl2_w: number | null; pl4_w: number | null;   // read now
  boot_pl1_w: number | null; boot_pl2_w: number | null;              // snapshot (null: none taken this boot)
  pl1_base_w: number | null;                                         // PL1 max_power_uw, shown only
  locked: string[];                                                  // "pl1" | "pl2"
};
export type PowerConflict = {
  id: string; name: string; kind: "blocks" | "cpu" | "suspect";
  ignorable: boolean; ignored: boolean; why: string; fix: string;
  fix_units: string[];                     // what Fix for me would stop and disable; [] = not offered
  fix_plan?: { disable: string[]; stop: string[] } | null;   // what it would run now; null = cannot tell
  fixed: PowerFixed | null;                // OXP3 Deck turned it off earlier (came_back: it runs again)
};
export type PowerFixedUnit = { unit: string; was_enabled: string; was_active: boolean };
export type PowerFixed = { id: string; name: string; at: number; units: PowerFixedUnit[]; came_back: boolean };
export type PowerFixStep = { unit: string; action: "disable" | "stop" | "enable" | "start"; ok: boolean;
                             error: string | null };
export type PowerOverridden = { what: string; ours: string; now: string; since: number; suspects: string[] };
export type PowerApply = {
  ok: boolean; error: string | null; written: string[];
  failed: { id: string; error: string; locked: boolean }[];
};
export type PowerState = {
  enabled: boolean;
  active: { key: string; name: string; slot: "main" | "ac"; app: string | null; ac: boolean | null };
  values: PowerValues;                    // the active slot as stored
  applied_values: PowerValues;            // after clamping and with firmware values filled in (what was written)
  now: { pl1_w: number | null; pl2_w: number | null;     // effective: the lowest over the zones
         zones: PowerZone[];
         gpu: { min: number | null; max: number | null; act: number | null; reasons: string[] } | null;
         epp: Epp | "default" | "mixed" | null; turbo: boolean | null; governor: string | null };
  range: PowerRange;
  overridden: PowerOverridden | null;
  blocked: string | null;                 // why nothing is written although enabled
  cpu_blocked: string | null;             // "<name> controls energy preference and CPU boost"
  cpu_blocked_by: string[];               // the conflict ids behind cpu_blocked (their Fix for me goes under EPP)
  last: PowerApply | null;                // the last apply
};
export type PowerInfo = {
  hw: { rapl: boolean; mmio: boolean; gpu: { card: string; gt: string; media_gt: string | null } | null;
        cpu: { pstate: string | null; epp_choices: Epp[]; turbo: boolean } | null;
        ac_supply: string | null; problems: string[] };
  options: PowerOptions;
  profiles: Record<string, PowerProfile>;  // "default" always present
  conflicts: PowerConflict[];
  fixed: PowerFixed[];                     // every record, also of conflicts that are gone (their Undo)
  boot: { taken_at: number } | null;
  sdtdp_found: boolean;                    // SimpleDeckyTDP's settings.json exists
  state: PowerState;
};
export type PowerSummary = { enabled: boolean; line: string | null; overridden: boolean; blocked: string | null };
// line e.g. "15 W / 25 W · Cyberpunk 2077" or "Off"
export type PowerInfoRes = Res & { info: PowerInfo | null };
export type PowerStateRes = Res & { state: PowerState | null };
export type PowerChangeRes = Res & { state: PowerState | null; applied: PowerApply | null;
                                     conflicts?: PowerConflict[] };   // conflicts: a refused enable
export type PowerImportRes = Res & { imported: string[]; skipped: string[]; state: PowerState | null };
export type PowerFixRes = Res & { steps: PowerFixStep[]; notes: string[]; state: PowerState | null;
                                  conflicts: PowerConflict[]; fixed: PowerFixed[]; applied: PowerApply | null };
// Overview gains: power: PowerSummary | null
```

`api.ts` (one per line, after "per game"):

```ts
// ---- power -------------------------------------------------------------------------------------------------------
export const power_info = callable<[refresh: boolean], PowerInfoRes>("power_info");
export const power_state = callable<[], PowerStateRes>("power_state");
export const power_enable = callable<[on: boolean], PowerChangeRes>("power_enable");
export const power_options = callable<[opts: Partial<PowerOptions>], PowerChangeRes>("power_options");
export const power_set = callable<[key: string, slot: "main" | "ac", values: Partial<PowerValues>], PowerChangeRes>("power_set");
export const power_profile = callable<[appid: string, name: string | null, on: boolean], PowerChangeRes>("power_profile");
export const power_game = callable<[appid: string | null], PowerChangeRes>("power_game");
export const power_take_control = callable<[], PowerChangeRes>("power_take_control");
export const power_import_sdtdp = callable<[], PowerImportRes>("power_import_sdtdp");
export const power_fix = callable<[cid: string], PowerFixRes>("power_fix");
export const power_unfix = callable<[cid: string], PowerFixRes>("power_unfix");
```

backend.ts wraps each one like the others (a failure gives `{ok: false, error, state: null, ...}`).

**Import from SimpleDeckyTDP** (data only, no code): `<homebrew>/settings/SimpleDeckyTDP/settings.json` via
`read_small` (untrusted, 1 MB). From `tdpProfiles`: `default` → default.main, `default-ac-power` → default.ac (and
`split_ac` on; built after review: `-ac-power` entries only when `advanced.acPowerProfiles` is true and per-game
profiles are on, as SimpleDeckyTDP uses them, else they are skipped and listed), `<appid>` / `<appid>-ac-power` likewise (a game profile created, name null); `tdp` → `pl1_w` (PL2
null = firmware boost, since SimpleDeckyTDP stores one value), `cpuBoost` → `turbo`, `minGpuFrequency` /
`maxGpuFrequency` → GPU min/max only when `gpuMode` is `RANGE` or `FIXED` (FIXED: both the same), an `epp` string in
`EPP_CHOICES` under `powerControls` → `epp`; anything else is skipped and listed. Values are stored (5..100 W), an
existing OXP3 Deck profile is replaced, `enableTdpProfiles` not true (SimpleDeckyTDP's default is false) imports
only the defaults. An imported game profile gets the game's name the first time it runs ("Profile for this game"
calls `power_profile(appid, name, true)`, which only sets the name). It never touches
SimpleDeckyTDP's files. Offered only when `sdtdp_found`.

### Frontend

- **`src/power.ts`** (framework-free, tested under node):
  - `makeWriter(send, opts?: {delay?: number, timers?})`: `write(key, slot, values)` merges into a pending change
    and sends it `delay` (250 ms) after the last call; while a send is in flight, newer changes wait and go as one
    when it answers (so changes reach the backend in order, at most one at a time, and a long slider drag applies about
    every half second); `flush()` sends at once (panel close, unmount); the answer's `state` is handed to `onState` only
    when no newer change is pending, so a late answer cannot snap a slider back.
  - `editSlot(state, options) : "main" | "ac"` (the slot the sliders edit: the active one), `shown(values,
    applied_values)` (a slider shows the stored value, or the applied firmware value when null), `pl2Floor(pl1, range)`,
    `clampW(v, range)`, `effectiveLine(state)` ("15 W / 25 W · GPU 1450 MHz, power-limited").
  - As built: the writer also sends a change at the latest `2 × delay` after its first write (a trailing debounce
    alone would never fire during a continuous drag); a change to another profile or slot is its own send, queued
    after the earlier one. `opts` also takes `onState`, `onAnswer(answer, stale)` and `now` (tests); the writer has
    `busy()` and `version()`, and `usePowerState` drops a poll answer that started before a write or lands while one
    waits (it would move a slider back). The store holds the one writer (`powerWriter`, over `power_set`). A slider
    shows a local draft until the stored value catches up; a refused change clears it and shows the error.
    `fwValues(state)` (the lowest boot value over the zones, the GPU's rpn..rp0) fills null fields of a profile that
    is not active, where `applied_values` belongs to another profile.
  - Built after review: `drain(): Promise<void>` flushes (also changes made while it waits) and resolves once nothing
    waits or is in flight. Every call that depends on the edits (`power_enable`, `power_options`, `power_profile`,
    `power_take_control`, `power_import_sdtdp`) awaits it first, so a slider change made just before a profile toggle
    lands on the profile it was made on.
- **`src/steam.ts`**: `onMainAppChange(cb: (appid: string | null) => void): () => void`, one shared registration of
  `GameSessions.RegisterForAppLifetimeNotifications` (re-read `Router.MainRunningApp` at once and after 1 s) plus a
  3 s `setInterval` comparing `runningApp()` (focus switches between running apps); `cb` only on a change.
  `useRunningApp` uses the same emitter (each 1 s re-read timer is dropped from the watch's set when it fires). No AC or suspend listeners in the frontend (the backend sees both).
- **`src/index.tsx`**: in `definePlugin`, `const stopPower = onMainAppChange((a) => power_game(a))` and one
  `power_game(runningApp()?.appid ?? null)` at load; `onDismount` calls `stopPower()`.
- **`src/store.ts`**: `useResource("power-info", () => power_info(false))` on the pages; a `usePowerState(active)` that
  reloads `power-state` every 2 s only while mounted and `active` (the panel or tab shows), never otherwise (reading
  the GPU clocks wakes the GPU); `invalidate("power")` after each change; the writer's `onState` updates the cached
  `power-state` entry.
- **`src/components/PowerControls.tsx`**: `<PowerSection quick />` and the Power tab share it.

**Quick Access panel**: a "Power" section after Status, before oxp3-tool (what is touched most in a game). Rows, all
focusable with the D-pad, each with its one-line description and Details (texts: "Frontend → Up-front text"):
1. Status line: `effectiveLine` and the active profile ("Cyberpunk 2077 · on AC" / "Default · on battery").
2. Red rows when relevant: `blocked` (with the conflict rows: Fix for me, Undo, How to fix), `overridden` (the drift text and a "Take control
   again" button), failed items of `last`, and every locked limit from `now.zones[].locked` (which lasts the boot,
   while an apply skips a locked id): "Limit capped at 25 W", one line "The device firmware won't allow more than
   25 W.", the interface and "the lower of the two wins" in its Details. The cached `power-info` (the conflict rows the fixes come from) reloads when
   `blocked` or `overridden.since` changes.
3. Toggle "TDP control". The first enable shows a confirm: what is written, that "off" restores the firmware values,
   that a reboot does too. A refused enable shows each blocking conflict's row (with Fix for me) under the toggle; after a fix
   that clears every blocker, the user taps the toggle again (the fix never turns power control on).
4. When enabled:
   - Toggle "Profile for this game" (only while a game runs and `per_game`): on → `power_profile(appid, name, true)`
     (copy of the default), off → delete (confirm).
   - Slider "Sustained power" (PL1, `pl1_min..pl1_max`, step 1 W, " W"). Its description names the profile it edits.
   - Slider "Boost power" (PL2, `max(pl1, pl1_min)..pl2_max`, step 1 W). Moving PL1 above PL2 moves PL2 with it in
     the same change.
   - Slider "GPU max clock" (`gpu_min..gpu_max`, step 50 MHz, notch label "efficient" at `gpu_efficient`).
   - Toggle "CPU boost" (turbo; disabled with "Locked by <name>." while `cpu_blocked`, and the conflict row of
     each `cpu_blocked_by` id, with its Fix for me, right under it).
   - EPP, GPU min, AC/battery split, the extended range and every profile live on the full page only.
   - Each slider shows the firmware value while its field is null; the description says "(device default)".
5. No "This game" changes: that section stays XeSS's.

**Full page**: a "Power" tab (`MdBolt`), first in the list (the gear still opens Fixes). Sections, top to bottom:
1. Status: the same rows as the quick panel, plus per zone the read PL1 / PL2 / PL4 (MSR and MMIO side by side, locked
   marks), GPU act clock and throttle reasons, EPP, turbo, governor, AC.
2. Control: "TDP control", "Per-game profiles" (`per_game`), "Separate values on AC" (`split_ac`), "Allow more than
   40 W on AC" (`extended`, OXP3 only, with a warning about chargers under 65 W).
3. Profile editor: a dropdown "Profile" (Default, then every game profile by name, the running game first) and, when
   `split_ac`, a dropdown "Values for" (Battery / On AC); then Sustained, Boost, GPU min clock, GPU max clock, EPP
   (dropdown: Firmware, Performance, Balance performance, Balance power, Power saving), CPU boost (dropdown: Firmware,
   On, Off); "Use firmware values" (all null, confirm); "Delete profile" for a game. Editing a profile that is not
   active saves it without applying (the backend applies only the active key).
4. Conflicts ("Other power programs"): every active one as a conflict row (Fix for me / Fix again / Undo / How to
   fix / "I've handled it"), then "Turned off by OXP3 Deck" (the records of conflicts that are gone, each with Undo),
   then "Check again" (`power_info(true)`). The EPP dropdown also carries the conflict row of each `cpu_blocked_by`
   id.
5. Firmware: boot values per zone and the GPU range ("Turning TDP control off restores these"), PL1 base power.
6. "Import from SimpleDeckyTDP" (when `sdtdp_found`), with the imported / skipped lines.

### Tests

**`tests/powerfake.py`** builds fake trees under `ctx.root` (`stub_decky.make_ctx`): `rapl(ctx, "intel-rapl:0" |
"intel-rapl-mmio:0", pl1=25, pl2=52, pl4=160, order=("long_term","short_term","peak_power"), base=25)`, `xe(ctx,
card="card1", gts={"gt0": "gt0-rc", "gt1": "gt1-mc"}, rpn=100, rpe=900, rp0=2300, minf=850, maxf=2300)` (with
`device/vendor` 0x8086 and a `device/driver` symlink to a folder named `xe`), `cpu(ctx, policies=14,
epp="balance_performance", governor="powersave", status="active", no_turbo=0)`, `ac(ctx, online=True)`,
`suspend(ctx, success=0)`, `plugins(ctx, {"SimpleDeckyTDP": enabled})`. `powerhw._write` is patched with a recorder
that writes the file and can fail (`PermissionError`, `OSError(EAGAIN)`, `EINVAL`, `EBUSY`, `EPERM`) or ignore a
write (an MMIO lock) per path.

**`tests/test_powerhw.py`**:
- discovery: MSR + MMIO; MSR only; MMIO only; none (`rapl: []`, a problem line); constraints in another order (by
  name); a zone without `long_term` skipped; `psys` and child zones ignored; a TPMI-like second `intel-rapl:N`
  `package-1` (both written).
- xe: gt0-rc + gt1-mc picks gt0; gtidle missing picks gt0; i915 card → `gpu: None` with a problem; `rp0_freq`,
  `rpn_freq` and all of gt1 unchanged after any apply (bytes compared); `read(gpu=False)` opens no min/max/act/cur
  file (patched `_read` records paths).
- order: raising (15 → 30 W) writes pl2 before pl1, lowering pl1 first; mmio zone before msr; an equal value is not
  written; GPU raising writes max first, lowering min first.
- PL4, `enabled`, `time_window_us`, psys never written (no recorded path matches).
- locked: `PermissionError` on msr pl1 → failed `locked: true`, mmio still written, the other constraint tried; a
  `locked` id is skipped; an ignored MMIO write → "did not take".
- EAGAIN twice then success → written; EINVAL → failed; EPP under `performance` governor → refused, nothing written;
  EPP not in `epp_choices` → refused; EBUSY on one policy → the rest written; `no_turbo` EPERM → failed.
- `ac_online`: Mains, USB only, battery status only, nothing; `suspend_count` missing → None.
- the writer opens with `O_NOFOLLOW` (a constraint file replaced by a symlink is not followed).

**`tests/test_power.py`**:
- limits: OXP3 battery 35, AC 40, extended AC = fw PL2 (52), extended ignored on battery, a non-OXP3 device capped at
  its boot PL1, PL2 capped by a short_term `max_power_uw` above 0 and not by 0, PL1 `max_power_uw` (25) not a bound,
  floor 5.
- clamping: 3 W → 5, 60 W on battery → 35, PL2 below PL1 → PL1, GPU outside rpn..rp0 → clamped.
- both interfaces get the same PL1/PL2; null PL2 = each zone's snapshot PL2 but ≥ PL1; null fields restore the
  snapshot.
- snapshot: taken before the first write, kept per boot_id, read back by a new `_Power` (plugin restart), retaken
  after a new boot_id; `enable(False)` writes it back.
- settings: defaults with no file; bad JSON; wrong types read as null; bad profile keys dropped; `MAX_PROFILES`;
  `profile()` copies default; `set_values` merges, null replaces, refused for an unknown key, copies main into a null
  ac first; `default` not deletable.
- active profile: appid with and without a profile, `per_game` off, `split_ac` on/off on AC and battery, `ac` null.
- enable refused for each blocking conflict; an ignored hhd does not block; a cpu conflict leaves PL1/GPU written and
  EPP/turbo not; `ignore` accepts only ignorable ids.
- conflicts from canned `systemctl list-units` output (`tests/fixtures/power/units-*.txt`: CachyOS with intel_lpmd,
  Bazzite with powerstation and thermald, hhd@jordan, nothing); Decky plugin enabled / in `disabled_plugins`; a
  `TdpLimit1` remote file; `systemctl` failing → one suspect row, nothing blocked.
- events: game change applies the new profile; resume by `suspend_count` and by a BOOTTIME jump (patched
  `time.clock_gettime`) applies at +3 s and verifies at +10 s (patched monotonic clock); AC flapping 5 times in 6 s
  gives one apply 2 s after the last change; while disabled, tick writes nothing.
- drift: after apply, a file changed → `overridden` with suspects, then no write on tick, AC, resume or game;
  `take_control` and `set_values` on the active profile write again; inside a grace window a change is re-applied (at
  most 3 times); GPU drift is only seen by `state()`.
- a blocker appearing while enabled → `blocked`, nothing restored.
- import: a SimpleDeckyTDP settings.json fixture (default, default-ac-power, a game, gpuMode RANGE and BALANCE,
  epp) → the right profiles and skipped list; a missing file; a 2 MB file refused.
- every public function answers a dict with `ok` and `error` on a tree with no power files at all.

**Fix for me / Undo** (`tests/test_power.py`, `sysexec.run` patched with a recorder that answers `list-units`
from the fixtures, `show` from a per-unit table and each command with a chosen rc):
- `fix("ppd")` on the owner's units (fixture `units-cachyos-owner.txt`: power-profiles-daemon and thermald
  active, powerstation not-found): records `{unit: "power-profiles-daemon.service", was_enabled: "enabled",
  was_active: true}` in power.json **before** the first command; runs exactly `[systemctl, "--no-ask-password",
  "disable", "--", "power-profiles-daemon.service"]` then `[..., "stop", "--", "power-profiles-daemon.service"]`;
  every argv's first item is absolute; `env_extra` is not passed (clean env); no argv contains "mask", "--now",
  "--runtime", "kill" or a unit outside `FIXABLE["ppd"]`; after it, `cpu_blocked` is null and EPP/turbo are
  applied (enabled) or not written (disabled); `recheck_at` is set and the tick 10 s later re-scans.
- `fix("tuned")` with only tuned-ppd loaded: one unit recorded and changed; a static unit is stopped but not
  disabled; a not-found or masked unit is skipped.
- `fix("thermald")` while enabled and blocked: `blocked` clears and `apply_at` is now; `fix("intel_lpmd")` with
  `max_perf_pct` 60 → the note; 100 → no note.
- refused, and nothing run: `fix("hhd")`, `fix("simpledeckytdp")`, `fix("../x")`, `fix(None)`, `fix(["ppd"])`, a
  FIXABLE id that is not active now, systemctl `list-units` failing.
- a failing `disable` (rc 1, stderr) → `ok: false` with that line, the record kept; `unfix` then enables only what
  the record says.
- `unfix("ppd")`: `enable` for `was_enabled == "enabled"` only, `start` for `was_active` only (a recorded `static` /
  `disabled` unit is never enabled, a not-active one never started); the record goes; the conflict is back
  (`cpu_blocked` again; a "blocks" id sets `blocked`, nothing restored). `unfix` without a record → refused.
- came back: a record plus the unit active again → the row's `fixed.came_back` true; Fix again keeps the first
  `was_enabled` ("enabled", not the "disabled" seen now); a unit first fixed while `disabled` and enabled again
  later records "enabled" on Fix again, and Undo enables it.
- Undo of a unit uninstalled or masked after the fix: no enable/start for it, the note, the record goes.
- power.json `fixed` validation: an unknown id, a unit not in `FIXABLE[id]` (e.g. `sshd.service`, `../../x`), a
  non-bool `was_active`, a 1000-char `was_enabled` → dropped; `options()` cannot write `fixed`.
- no fix or undo without a call: `tick`, `enable`, `game`, AC and resume never run `disable`, `stop`, `enable` or
  `start` (the recorder sees only `list-units` and `show`).
- `CONFLICTS` fix texts contain no "mask"; `_UNITS["hhd"]` matches `hhd_local@jordan.service`; the no-RAPL problem
  names `processor_thermal_rapl`.

**`tests/test_main.py`**: the eleven calls in `CALLS` (with `"power_fix": ("ppd",)`, `"power_unfix": ("ppd",)`) (e.g. `"power_set": ("default", "main", {"pl1_w": 15})`);
`Base.setUp` also sets `power` to `Raising()`; `_main` starts the watch task and `_unload` cancels it (no task left);
a raising `tick` does not end the loop; power calls answer while a job runs; the overview answers with a raising power
module (`power: null`). The signature test covers the `_mod("power")` calls.

**`tests/js/conflicts.test.mjs`**: every id of power.py's `CONFLICTS` (read from the file) has a friendly name, a
one-liner of at most 80 chars and no "sudo", "systemctl" or "/" in it; every FIXABLE id has a `fixConfirm` whose
`lines` name each unit and whose text says "Undo"; ppd's and tuned's say "may start again"; no text says "mask"
except "not masked"; `undoConfirm` lines are enable/start only. **`tests/js/text.test.mjs`**: `firstSentence`.
**`tests/js/pages.test.mjs`** also: no `explain(` call with a second argument in `src/`; no `tooltip=` and no
`explainer=` prop; no "sudo " in a `description=` or `explain(` string; `PowerControls.tsx` and `Power.tsx` render
`<ConflictRow`; `power_fix(` and `power_unfix(` are each called only after a `confirm(` in the same function.
**`tests/js/power.test.mjs`**: `makeWriter` with fake timers (trailing send, one in flight, merged pending, order,
stale answer ignored, flush), `editSlot`, `shown`, `pl2Floor`, `clampW`, `effectiveLine`.
**`tests/js/pages.test.mjs`**: `index.tsx` registers `onMainAppChange` and calls its stop in `onDismount`;
`PowerControls.tsx` never calls `power_set(` inside an `onChange` (only the writer); `Quick.tsx` renders
`<PowerSection` before the oxp3-tool section; `Full.tsx` has the Power tab.
**`tests/test_package.py`**: `power.py` and `powerhw.py` in the zip listing.

On the device (owner, after the build): MSR and MMIO read-back under load (`act_freq` 2300 MHz at 35 W with
`reasons` none), AC unplug and plug (MMIO reset re-applied), suspend and resume, a game switch, Steam's TDP slider
flagged as drift, `enable(False)` back to 25/52 and 35/52 W. Fix for me on power-profiles-daemon and thermald (EPP
and CPU boost become settable; `systemctl is-enabled` reads disabled, nothing masked), Undo (both enabled and running
again), then Fix again after starting CachyOS's game-performance (came back shown). The ☰ Details footer on a
ToggleField, SliderField and DropdownItem, and A on a Status row with Details.

### Docs and credits

- DESIGN.md: Layout gets `powerhw.py`, `power.py`, `src/power.ts`, `components/PowerControls.tsx`, `pages/Power.tsx`,
  `tests/powerfake.py`, `tests/test_powerhw.py`, `tests/test_power.py`, `tests/js/power.test.mjs`,
  `tests/fixtures/power/`; "State the plugin keeps" gets `power.json` and `/run/oxp3deck/power-run.json`; Frontend
  gets the Power section and tab (pointing here).
- README (this change, done): replace "OXP3 Deck never stops, disables or masks another service" with the Fix for me
  rule (stop and disable after a confirm, never mask or uninstall, Undo; the D-Bus "may start again" limit); the
  conflicts table gets the Fix for me column and loses the powerstation mask advice.
- README: "Power (TDP and GPU clocks)": what it sets and why both RAPL interfaces; "Moving from SimpleDeckyTDP"
  (Import, then disable or uninstall it in Decky, turn TDP control on); the conflicts table with the fixes above; the
  thermald trade-off; Steam's own TDP and GPU sliders off; "turning it off or rebooting gives the firmware values
  back; uninstalling OXP3 Deck leaves the current limits until the next reboot".
- CREDITS.md: a "SimpleDeckyTDP" section (BSD-3-Clause, Copyright (c) 2023, Aarron Lee): the profile model (default,
  per game, `-ac-power`), the resume delays and the settings format the import reads; no code copied. The ClawDeck
  section adds: the PL2/PL1 write order, the xe gt0-not-media rule and the thermald finding (HARDWARE-FINDINGS §12,
  §21, §22) informed powerhw.py. Handheld Daemon (LGPL), PowerStation (GPL) and onexplayer3-steamos-setup are named as
  research sources only (the MSR-follows-GPU finding comes from onexplayer3-steamos-setup's README).
- If a builder does adapt SimpleDeckyTDP code after all: the file's first line `# Adapted from SimpleDeckyTDP
  (BSD-3-Clause, Copyright (c) 2023, Aarron Lee). See THIRD_PARTY_NOTICES.md.` (`//` in TypeScript), and a
  "## SimpleDeckyTDP" section with the full BSD-3-Clause text in THIRD_PARTY_NOTICES.md (under "In the plugin zip"
  when it reaches `dist/index.js` or `py_modules`). Its mobx suspend helper is never taken (it carries SDH-PlayTime's
  and moondeck's licences). ClawDeck code keeps the existing MIT header line.

## Power 0.4: new CPU and GPU controls, live readouts, polling rate

Version 0.4.0 (package.json; the integrator bumps it). The facts come from the kernel source (CachyOS 7.2.11, v7.2,
7.3.1, 7.4-rc1), checked for this batch; nothing below is measured on the device yet, so every "helps games" claim is
a hint in Details, never a promise up front. Everything in this section is power.py / powerhw.py: written only while
"TDP control" is on, per profile (default, per game, AC slot), clamped, read back, re-applied on game / AC / resume
like PL1, drift-detected like EPP, restored by "TDP control" off from the boot snapshot.

### New fields (power.json `PowerValues`, every slot)

| Field | Stored bounds | null means | Applied |
|---|---|---|---|
| `cpu_max_pct` | int 30..100 | the snapshot's `max_perf_pct` (100) | always; refused together with any `cpu_cap_*` |
| `cpu_min_pct` | int 1..50 | the snapshot's `min_perf_pct` (9 on the owner's unit) | **only while AC is online**; on battery (or AC unknown) the snapshot value is written; clamped to `[snapshot min, min(50, effective cap)]` |
| `soc_balance` | int 1..5 | the snapshot's `slider_balance` (3) | always; takes effect only while the SoC profile reads `balanced` |
| `soc_offset` | int 0..3 | the snapshot's `slider_offset` (0) | with `soc_balance` |
| `gpu_power_profile` | `"base"` \| `"power_saving"` | the snapshot's (`base`) | render GT only |
| `cpu_cap_p_mhz`, `cpu_cap_e_mhz`, `cpu_cap_lpe_mhz` | int 400..6000 | that type's snapshot `scaling_max_freq` per policy | refused together with `cpu_max_pct` |
| `epp_p`, `epp_e`, `epp_lpe` | one of `EPP_CHOICES` | the profile's `epp` (then the snapshot) | per policy of that core type |
| `fan_mode` | `"auto"` \| `"quiet"` \| `"max"` | Auto (nothing written unless something else was) | **by extras.py**, not power.py; also while TDP control is off |
| `scx_mode` | `"auto"` \| `"gaming"` \| `"powersave"` | leave the loader's mode as it is | **by extras.py**; also while TDP control is off |

- `FIELDS` (power.py and src/power.ts) grows by these 13 names in this order; `EMPTY` gets them as null. Old
  power.json files read them as null (migration-free, as before); a wrong type or out-of-bounds value reads as null.
- **Mutual exclusion**: after the merge of `set_values`, a slot with `cpu_max_pct` non-null and any `cpu_cap_*`
  non-null is refused (`"use either the CPU speed cap or the per-core caps, not both"`), nothing saved. The frontend
  sends the switch as one change (`{cpu_max_pct: null, cpu_cap_p_mhz: 2400, ...}`), after a confirm (texts below).
- power.py never writes `fan_mode` or `scx_mode` to hardware; it validates, stores, copies them with the profile
  (`profile()` copy, `set_values` merge, SimpleDeckyTDP import leaves them null) and hands them out through
  `power.active()`.
- `options` gains `poll_s` (below). `OPTION_DEFAULTS["poll_s"] = 2`.

### Discovery (`powerhw.discover`, additions to `Hw`)

```python
"cpu": {..., "perf_pct": bool,                    # intel_pstate/max_perf_pct and min_perf_pct both exist
        "types": {"p": ["policy0", ...], "e": [...], "lpe": [...]},   # groups with no policy are left out
        "type_range": {"p": {"min_mhz": 400, "max_mhz": 5100}, ...}},  # cpuinfo_min/max_freq (kHz → MHz), over
                                                                        # the group: min of mins, max of maxes
"soc": {"params": "/sys/module/processor_thermal_soc_slider/parameters",
        "profile": "/sys/class/platform-profile/platform-profile-0"} | None,
"gpu": {..., "power_profile": bool}               # freq0/power_profile exists (render GT)
```

- **Core types**: a policy's type is that of the first CPU in its `affected_cpus`. CPU N is P when it is in
  `/sys/devices/cpu_core/cpus` (a kernel cpulist, "0-3,8"; parse ranges and commas), E or LP-E when it is in
  `/sys/devices/cpu_atom/cpus`: LP-E when `/sys/devices/system/cpu/cpu<N>/cache/index3` does not exist (no L3), else E.
  Neither file (not hybrid): every policy is `p`. A CPU in neither list: `p`.
- **SoC slider**: `soc` is set only when the params folder has both `slider_balance` and `slider_offset` **and** one
  `/sys/class/platform-profile/platform-profile-*` (scandir, `^platform-profile-\d+$`) has `name` exactly
  `SoC Power Slider`; that one's folder is `profile`. Never by index.
- No new problem lines; a missing part just hides its control (the frontend checks `info.hw`).

### Reading (additions)

```python
{"perf": {"max": 100, "min": 9} | None,           # int(max_perf_pct), int(min_perf_pct)
 "caps": {"policy0": 5100000, ...} | None,         # scaling_max_freq, kHz
 "soc": {"balance": 3, "offset": 0, "profile": "balanced", "choices": ["low-power", "balanced", "performance"]} | None,
 "gpu": {..., "profile": "base" | "power_saving" | None},   # read also with gpu=False: the show function does not
                                                            # wake the GPU (it prints a cached value)
 ...}
```

- Slider params are hex (`kstrtou8(arg, 16)`), shown as two hex digits (`03`): read with `int(text, 16)`, written as
  `f"{v:02x}"`. `profile` is the word in the file; `choices` from the same folder's `choices` (split on spaces).
- `power_profile` reads `[base]    power_saving` (the bracketed word is the value), or `invalid` → None.

### Target and apply (additions; `powerhw.apply` steps 7–10 after turbo, before the read-back)

```python
{"perf": {"max": 70, "min": 9}, "caps": {"policy4": 2400000, ...}, "soc": {"balance": 4, "offset": 0},
 "gpu_profile": "power_saving", "epp": {"policy0": "performance", "policy4": "balance_power", ...}}
```

7. **perf** (ids `cpu/max_pct`, `cpu/min_pct`): the driver clamps the cap to `[floor, 100]` and the floor to
   `[minimum, cap]`, so: if the new max ≥ the current max, write `max_perf_pct` first, then `min_perf_pct`; else
   `min_perf_pct` first (lower the floor first when moving down), then `max_perf_pct`. power.py guarantees min ≤ max;
   powerhw's last guard lowers a target `min` above the target `max` to it. An equal value is not written. Never
   "0" (the driver reads it as "the floor").
8. **caps** (ids `cpu/cap/policyN`): each policy's `scaling_max_freq` in kHz, clamped to
   `[that policy's scaling_min_freq read now, its ceiling]`; the ceiling is `cpuinfo_max_freq`, or, while
   `no_turbo` reads 1, `min(cpuinfo_max_freq, base_frequency)`: intel_pstate (kernel 7.2,
   `intel_pstate_verify_cpu_policy`) clamps policy->max to the non-turbo maximum then, so the boot value (5100 MHz)
   reads back as the base speed. Compared with a fresh read of `scaling_max_freq`, not `before` (step 4 may have
   just turned turbo off). Read back within `CAP_TOLERANCE_KHZ = 100_000` (HWP rounds to its ratio steps). EINVAL →
   failed for that policy, the others go on. (0.4.x fix: before it, CPU boost off made every per-core cap fail and a
   later change that wrote nothing was refused as a whole with "cpu/cap/policy0: did not take".)
9. **soc** (ids `soc/offset`, `soc/balance`, `soc/profile`): write `slider_offset`, then `slider_balance`, then, only
   when the `profile` file reads exactly `balanced` now, write `balanced` to it (the kernel never skips a same-value
   write, and that write is what sends the slider to the firmware). When it reads anything else, the params are
   still written (power-profiles-daemon's next `balanced` picks them up) and `soc/profile` is neither written nor
   failed. `slider_balance` EINVAL (the driver refuses 0 and 6) → failed. The legacy
   `/sys/firmware/acpi/platform_profile` is never touched (it would write every handler).
10. **gpu_profile** (id `gpu/profile`): write `base` / `power_saving` to `freq0/power_profile`, EAGAIN retried like the
   clocks, then read back, and only when the value differs: on 7.2 `power_profile_store` takes `guard(xe_pm_runtime)`,
   so the write wakes the GPU (the no-resume guard is only inside `xe_guc_pc_set_power_profile`); reading the file
   does not wake it. Any OSError (EAGAIN after the retries from a GT reset or resume, a GuC error as EIO, ENODEV,
   EBUSY) or a read-back that differs is a failed item with `transient: True` (not an error the UI shows in red;
   "Polling rate" retries it). The driver keeps
   the value across resume and GT reset (`xe_guc_pc_start`) and resets it to `base` at boot.

- **EPP split**: when any of `epp_p`/`epp_e`/`epp_lpe` is non-null, power.py's target `epp` is a dict per policy:
  each policy gets its type's field, else `epp`, else the snapshot's value. powerhw's dict path already exists (step
  4). `ours` then records `epp/<first policy of each type>` instead of `epp`, and the drift check compares those.
- `ApplyResult.failed[]` items gain `transient: bool` (false unless said above). `written` ids as listed.
- Read-back comparisons: perf exactly, caps within 100 MHz, soc params exactly, gpu profile exactly.
- (Built: the 7.2 driver's `slider_balance` show prints the value in use, which changes only at a profile write, so
  when the profile does not read `balanced` the balance is written but not read back and not put in `ours`; the
  next apply writes it again, which is harmless. A failed item that is only `transient` does not make an apply fail
  as a whole (`ok` stays true). Each failed item carries `transient`.)

### Snapshot, restore, drift, conflicts

- **Snapshot** gains `perf {max, min}`, `caps {policy: kHz}`, `soc {balance, offset}`, `gpu_profile`. Built: the run
  file of a plugin upgraded in the middle of a boot has a snapshot without these keys, so `_ensure_snapshot` fills
  **missing keys only** (read now) before the first write that needs them; existing keys are never retaken.
- **Restore** ("TDP control" off) writes them back with the same orders (perf order rule; soc: params, then
  `balanced` only if it reads `balanced`).
- **Resolve**: `cpu_max_pct` → `perf.max`; `cpu_min_pct` → `perf.min` only when `ac is True`, else the snapshot min;
  the effective floor is `min(that, perf.max)`. Caps: each policy of type T gets `cpu_cap_T_mhz × 1000` or its snapshot
  value. `applied_values` reports the new fields the same way (W/MHz/%, the firmware value for nulls).
- **Drift**: `ours` gets `cpu/max_pct`, `cpu/min_pct`, `cpu/cap/<first policy of each type>`, `soc/balance`,
  `soc/offset`, `gpu/profile` (only when written and read back). The tick's `read(gpu=False)` includes them. A change
  of the platform profile itself (power-profiles-daemon switching to `performance` and back) is **not** drift: OXP3
  Deck does not own it. Suspects (`_suspects`): `cpu/*` and `soc/*` → the active "cpu" conflicts and `hhd`;
  `gpu/profile` → the "blocks" ones; none found → `["other"]` (UI: "Another program"; `"steam"` stays the fallback
  for RAPL and GPU clocks only).
- **Who blocks which field** (`FIELD_BLOCKERS` in power.py; a blocked field is not written, not restored, and its
  `ours` entries are dropped, as EPP/turbo today):

  | Field group (key in `blocked_fields`) | Blocked by (active, not ignored) |
  |---|---|
  | `epp` (epp, epp_p/e/lpe), `turbo` | every "cpu" conflict (unchanged) |
  | `cpu_pct` (cpu_max_pct, cpu_min_pct), `cpu_caps` | `intel_lpmd`, `tuned` (power-profiles-daemon does not write them) |
  | `soc` | `intel_lpmd` (it writes the slider; power-profiles-daemon cooperates: its `balanced` uses our value) |
  | `gpu_profile` | nothing |

  `intel_lpmd` counts as no blocker while `extras.lpmd_paused(ctx)` is true (OXP3 Deck has it in LPM_FORCE_OFF for
  the running game). power.py imports it lazily (`from . import extras` inside try; ImportError or any exception →
  False). `state.cpu_blocked` / `cpu_blocked_by` keep their meaning (EPP and boost).
- **`fix("intel_lpmd")` note**: unchanged, except no note when OXP3 Deck's own `cpu/max_pct` is in `ours`.
- (Built: `power._lpmd_paused(ctx)` wraps the lazy `extras.lpmd_paused`, which runs under power's lock and so must
  never take extras' lock; extras.py's does not. When a drift check finds a field group newly blocked, every
  blocked group's `ours` entries are dropped and the tick answers "nothing". Suspects for EPP and boost now fall
  back to "other" too, since Steam does not set them. A power.json slot that holds both the speed cap and per-core
  caps, written by hand, reads its per-core caps as null.)

### Polling rate (`poll_s`)

How often the backend re-checks the power settings and retries what did not take. `power_options({poll_s})`:
an int, `0` (Off) or 2..60; anything else refused. Default 2 = the 0.3 behaviour.

- main.py's watch loop stays at `TICK_S = 2` (AC, resume, game, the conflict recheck, the boot apply and the extras'
  safety checks keep their timing whatever `poll_s` is).
- tick step 5 (the drift check) runs only when `poll_s > 0` and `now − p.last_poll ≥ poll_s` (then `last_poll = now`).
  Inside a grace window (after AC or resume) it runs every tick regardless, as 0.3 does. Off: no drift check outside
  grace windows (an override then shows only when `state()` runs while a panel is open, for the GPU clocks, or at the
  next apply's read-back).
- At the same moments, the ids in `p.pending` (failed with `transient: True` at the last apply) are written again
  (`_apply`, which writes only what differs) at most `PENDING_RETRIES = 30` times per apply; a success clears them.
- It never re-writes over another program (Drift's rule stays): "re-applies" means retrying what the device itself
  did not take (the GPU busy resetting or resuming) and the grace-window re-applies.
- UI: slider over the steps `POLL_STEPS = [0, 2, 3, 5, 10, 15, 20, 30, 45, 60]` (index slider; label "Off" for 0,
  "<n> s" otherwise). Power tab only.

### Live readouts (`readouts.py`, `power_live`)

Read only, no settings, no lock shared with power.py (its own `threading.Lock`; state per `ctx.root`). Every path
through `ctx.sys_path`. Found by name, never by number; discovery cached in the module and redone when a cached path
stops reading.

```python
def sample(ctx) -> dict      # {ok, error, live: Live}; never raises
```

| Value | Source | Rule |
|---|---|---|
| `package_w` | `/sys/class/powercap/intel-rapl:<N>/energy_uj` of the MSR zone named `package-0` (never MMIO: counting both doubles it) | Δenergy / Δt (monotonic); Δ < 0 → add `max_energy_range_uj`; first sample, Δt < 0.2 s or > 30 s → null; 1 decimal |
| `battery` | the first `power_supply` whose `type` is `Battery` (BAT0) | `status`; `capacity`; `draw_w` = `power_now` µW, else `current_now × voltage_now`; `time_left_min` = `energy_now / power_now` (or `charge_now / current_now`) when Discharging; `time_to_full_min` when Charging, to `charge_control_end_threshold` if present else 100 %; null when unreadable or draw < 0.5 W |
| `cpu_temp_c` | hwmon whose `name` is `coretemp`: the `tempN_input` whose `tempN_label` is `Package id 0`, else `temp1_input` | m°C → °C, 1 decimal. Also the GPU's temperature (no separate iGPU sensor) |
| `gpu.busy_pct` | render GT `gtidle/idle_residency_ms` | `100 − 100 × Δidle_ms / (Δt × 1000)`, clamped 0..100, integer |
| `gpu.cur_mhz`, `gpu.act_mhz` | `freq0/cur_freq` (requested), `act_freq` (granted) | these reads wake the GPU: only called while a panel shows |
| `gpu.reasons` | `freq0/throttle/reasons` | as powerhw (prefix `reason_` dropped, `none` → []) |
| `throttle.cpu_ms` | `cpu0/thermal_throttle/package_throttle_total_time_ms` | Δ since the last sample (null on the first); `throttle.cpu` = Δ > 0 |
| `fan_rpm` | hwmon `name` `oxp_ec` → `fan1_input` (kernel 7.4+) | null otherwise (acpi_fan is not used: unchecked on the device) |

`Live = {t, package_w, battery: {status, percent, draw_w, time_left_min, time_to_full_min} | null, cpu_temp_c,
gpu: {busy_pct, cur_mhz, act_mhz, reasons} | null, throttle: {cpu_ms, cpu, gpu: string[]}, fan_rpm}` (all numbers may
be null; `throttle.gpu` = `gpu.reasons`).

Frontend: `useLive(active)` in store.ts polls `power_live()` every `LIVE_MS = 1000` only while mounted and `active`
(the quick panel or Power tab is shown), one call in flight at a time and one shared poller for every mounted
user (the quick panel over the Power tab would otherwise sample twice within the backend's 0.2 s and read nulls),
stopped on unmount and on `stopPolling`. The Power tab also stops while `document.hidden` (`usePageVisible`; whether
Steam hides the page behind a running game is to be checked on the device). Quick
panel: one row (top of the Power section, also while TDP control is off) "Live" with the line from `live.ts`
`liveLine(live)`: "18.4 W · 62 °C · GPU 87 % · 3 h 10 min left" (parts that are null left out); Details: every value
of the table, "requested 1500 MHz, running 1450 MHz", why it is slow (`whySlow(live)`: "CPU too hot" when
`throttle.cpu`, the GPU reasons through `reasonText`, else "Not held back"), the fan RPM, and "Technical:" the sources.
The Power tab shows the same values as separate Status rows under "Live readouts" (each row one value).

## Extras (extras.py)

Battery charge limit, charge behaviour, fan mode, scx_lavd mode, intel_lpmd off during games. One module, its own
`threading.RLock` (never held while power.py's is: main.py calls them one after the other), its own settings
(`extras.json`, `context.Settings`) and run state (`/run/oxp3deck/extras-run.json`, root's 0600, `write_atomic` into
`sysexec.run_dir(ctx)`, ignored when its `boot_id` is not this boot's). Every result `{ok, error, ...}`, never raises;
subprocesses through `sysexec.run` (clean env, stdin /dev/null, argv list, absolute path) in the executor.

### What it writes

- `/sys/class/power_supply/<battery>/charge_control_end_threshold` (50..100) and `charge_behaviour` (`auto` or
  `inhibit-charge-awake`; **never** `inhibit-charge`, which also blocks charging asleep and can leave a flat
  battery: the validator refuses it and the writer has no path to it).
- The `oxp_ec` hwmon's `pwm1_enable` (2 auto, 1 manual, 0 full speed) and `pwm1` (0..255, the driver scales it to the
  EC's 0..184).
- D-Bus (system bus, root, through `busctl`): org.scx.Loader `SwitchScheduler` / `SwitchSchedulerWithArgs`, and
  intel_lpmd `LPM_FORCE_OFF` / `LPM_AUTO` / `LPM_FORCE_ON`. Nothing else: no `StartScheduler` (OXP3 Deck never
  starts a scheduler that is not running), no `StopScheduler`, no `Terminate`, no lpmd process lists.

### Gates (when a control exists)

- **Battery and fan (kernel 7.4+)**: `/sys/class/dmi/id/board_name` stripped is exactly `ONEXPLAYER 3` **and** an hwmon
  whose `name` is `oxp_ec` exists **and** the file itself exists (the battery = the first `type` `Battery` supply).
  The `ONEXPLAYER 3` entry is only in mainline 7.4-rc1's oxpec.c (DMI_EXACT_MATCH on the board name); 7.2, 7.3 and
  their stable branches lack it. Otherwise the control is absent from `ExtrasState` (`available: false`, `why`:
  "Needs Linux 7.4 or newer (this is <release>)." when the board matches and the files do not exist; "Only on the
  ONEXPLAYER 3." otherwise). The UI hides unavailable battery and fan rows; the Power tab shows one Note "Battery
  and fan controls need Linux 7.4" when only the kernel is missing. `charge_behaviour`'s offered values are
  `auto` and `inhibit-charge-awake`, filtered by the words the file lists.
- **scx mode**: `/sys/kernel/sched_ext` exists (else the row is hidden). Then `busctl --system --auto-start=no
  --json=short get-property org.scx.Loader /org/scx/Loader org.scx.Loader CurrentScheduler` must answer (else
  greyed: "The scheduler loader isn't running."; `--auto-start=no`: OXP3 Deck never D-Bus-activates it), and the
  answer must be `scx_lavd` (else greyed: "Only for the LAVD scheduler; <name> runs now." / "No scheduler runs
  now." for `unknown`).
- **intel_lpmd**: `intel_lpmd.service` active (one `systemctl is-active --quiet intel_lpmd.service`, cached 60 s;
  inactive on the owner's unit) — else the row is hidden.

### The D-Bus APIs (verified from source for this design)

- **scx-loader** (github.com/sched-ext/scx-loader at 259bb6c, 2026-10-29; `configs/org.scx.Loader.xml`,
  `crates/scx_loader/src/{main,dbus,lib}.rs`): bus name `org.scx.Loader`, object `/org/scx/Loader`, interface
  `org.scx.Loader`. Properties `CurrentScheduler` (s, "unknown" when none), `SchedulerMode` (u: 0 Auto, 1 Gaming,
  2 PowerSave, 3 LowLatency, 4 Server), `CurrentSchedulerArgs` (as; non-empty when started with custom arguments).
  Methods `SwitchScheduler(s scx_name, u sched_mode)`, `SwitchSchedulerWithArgs(s, as)`. The bus policy allows root
  everything; the methods check polkit action `org.scx.loader.manage-schedulers` (root passes). The default config
  maps scx_lavd's modes to `--autopilot` / `--performance` / `--powersave` (each with `--pinned-slice-us 500`).
  Switching **with a mode** drops custom arguments, so the arguments seen before are restored with
  `SwitchSchedulerWithArgs` when they were non-empty. Only the methods above, which older loaders have too, are used
  (not `SchedulerModes` / `DefaultMode`, which are newer).
- **intel-lpmd** (github.com/intel/intel-lpmd at 9ece012, 2026-11-05; `src/intel_lpmd_dbus_interface.xml`,
  `src/lpmd_dbus_server.c`): bus name and interface `org.freedesktop.intel_lpmd`, object `/org/freedesktop/intel_lpmd`.
  Methods `LPM_FORCE_ON`, `LPM_FORCE_OFF`, `LPM_AUTO` (no arguments), `GetState` → s (`OFF`, `ON`, `AUTO`,
  `PROCESS-PRECONFIG`, `FREEZE`, `RESTORE`, `TERMINATE`, `UNKNOWN`). The privileged methods need uid 0 and are
  **rate limited: one privileged call per 2 s** ("rate limited: too many privileged requests"), so extras makes at
  most one lpmd call per tick and retries a rate-limited one at the next tick. `GetState` may be missing in older
  builds: an error answer reads as state `null`.
- Commands (exact argv, `B = sysexec.which("busctl") or "/usr/bin/busctl"`, timeout `BUS_TIMEOUT_S = 2` s):
  - `[B, "--system", "--auto-start=no", "--json=short", "get-property", "org.scx.Loader", "/org/scx/Loader",
    "org.scx.Loader", <Prop>]` → stdout `{"type":"s","data":"scx_lavd"}` (`u` → int, `as` → list).
  - `[B, "--system", "--auto-start=no", "call", "org.scx.Loader", "/org/scx/Loader", "org.scx.Loader",
    "SwitchScheduler", "su", <name>, str(mode)]`;
    `[..., "SwitchSchedulerWithArgs", "sas", <name>, str(len(args)), *args]`.
  - `[B, "--system", "--auto-start=no", "call", "org.freedesktop.intel_lpmd", "/org/freedesktop/intel_lpmd",
    "org.freedesktop.intel_lpmd", <Method>]` (`GetState` with `--json=short` → `{"type":"s","data":["AUTO"]}`).
  - The scheduler name is checked against `^scx_[a-z0-9_]{1,40}$` and each argument against `^[-A-Za-z0-9_.=,]{1,64}$`
    (at most 32) before they go into an argv; anything else is not restored (note "the scheduler's own arguments
    could not be put back; restart scx_loader").

### Settings (`extras.json`) and run state

```json
{"version": 1, "charge_limit": null, "charge_behaviour": null, "lpmd_game_off": false}
```

`charge_limit` int 50..100 or null (never written); `charge_behaviour` `"auto"` | `"inhibit-charge-awake"` | null;
`lpmd_game_off` bool. Same normalisation rules as power.json (bad values read as default, unknown keys dropped).
These are global (not per profile): a battery setting follows the battery, not the game. `fan_mode` and `scx_mode`
are per profile and live in power.json (above).

```python
{"boot_id": str,
 "fan": {"ours": "quiet" | "max" | None, "reverted": str | None, "overridden": str | None, "key": str | None},
 "scx": {"before": {"sched": str, "mode": int, "args": [str]} | None, "ours": int | None, "overridden": str | None},
 "lpmd": {"paused": bool, "before": str | None, "app": str | None, "error": str | None},
 "charge": {"limit": int | None, "behaviour": str | None, "overridden": {"limit": str|None, "behaviour": str|None}},
 "suspend_count": int | None}
```

### Behaviour (`tick(ctx, active)`, every 2 s from main.py's watch loop, and `sync(ctx, active)`)

`active` is `power.active(ctx)` (below), or None when the power module did not load (then: no app, every
profile field null, so only the charge settings and the safety rules act). `sync` does steps 2–4 at once after a profile change (main.py calls it after
every power_set / power_game / power_profile / power_options / power_enable / power_take_control and after
extras_set); `tick` does steps 1–5.

1. **Fan safety first** (only while `fan.ours` is quiet or max): read the coretemp package temperature (as
   readouts.py; extras has its own small reader); ≥ `FAN_HOT_C = 90` °C while quiet (max is already full speed:
   Auto could slow the fan while hot, so max is left), or unreadable in either → write `pwm1_enable` 2, `ours`
   None, `reverted` = "The CPU reached 90 °C" / "The temperature couldn't be read", and the profile's fan mode is
   not applied again until the user changes a fan setting or the active profile key changes (no oscillation).
2. **Fan mode**: wanted = `active.values.fan_mode` or `auto`. If wanted is auto and `ours` is None → nothing (never
   write when nothing was changed). auto → `pwm1_enable` 2; quiet → `pwm1_enable` 1 then `pwm1` = `FAN_QUIET_PWM =
   102` (about 40 %, a constant to tune on the device); max → `pwm1_enable` 0 (the driver sets 255). Read back
   `pwm1_enable`: auto must read 2; quiet/max must read 1 or 0 (the driver reports 0 only at full speed). Any OSError
   → write 2 once more, `ours` None, `reverted` = "Fan control failed: back to Auto (<strerror>)". Quiet and Max
   need the sleep watch (Safety) running; if it cannot start, Auto and `reverted` "Can't watch for sleep, so the fan
   stays on Auto".
   **Drift**: `ours` quiet/max and `pwm1_enable` reads 2 (outside 10 s after a resume) → `overridden` "Something
   else set the fan back to Auto" (Handheld Daemon, steamos-manager), no fan writes until `extras_take_control("fan")`
   or a fan setting change.
3. **scx mode** (0.4.x warning: the owner saw a game freeze when the mode was switched while it ran. The row's line is
   "Can freeze a running game: change it before you start the game." and its Details say "Changing it while a game
   runs can freeze the game; change it before starting the game." While a game runs and the edited profile slot is
   the active one (the change would apply now), the dropdown and "Take control of the scheduler" ask first
   ("Change the scheduler mode now?", destructive, Cancel keeps the old mode). A confirm rather than "apply at the
   next game start": the mode is per profile and a game profile already switches at its game's start, while the game
   loads, so deferring would still switch with a game running and would make the dropdown show a mode that is not
   in effect; the confirm keeps the owner's choice explicit, defaults to not switching, and needs no backend state):
   wanted = `active.values.scx_mode` (null = leave). Read the three properties at most every
   `SCX_CHECK_S = 10` s (and right before a call). When wanted is set, the loader runs `scx_lavd` and
   `SchedulerMode` ≠ wanted: on the first change record `before` (sched, mode, args), then `SwitchScheduler
   ("scx_lavd", mode)`; `ours` = mode. When wanted becomes null and `before` is set: restore (args non-empty →
   `SwitchSchedulerWithArgs`, else `SwitchScheduler(before.sched, before.mode)`), clear `before` / `ours`.
   **Drift**: `ours` set and the loader's mode or scheduler differs (CachyOS's game-performance or
   power-profiles-daemon switch modes too) → `overridden` "Something else changed the scheduler mode", `before`
   dropped (that program owns it now), no calls until take_control or a change of `scx_mode`.
4. **intel_lpmd** (only with `lpmd_game_off` on and the service active): `active.app` set and not paused →
   `GetState`; `OFF` already → nothing (paused stays false); else `LPM_FORCE_OFF`, `paused = true`, `before` = the
   state (`AUTO` / `ON` / null), `app` = the game. `active.app` null (or another app after a game change: restore
   first, pause again on the next tick), option turned off, or unload → `LPM_FORCE_ON` when `before` was `ON`, else
   `LPM_AUTO`; `paused = false`. While paused, a `GetState` other than `OFF` (the daemon restarted) → `paused =
   false`, one new pause for the same game at most. A change of `paused` sets the tick's answer
   `lpmd_changed: true` (main.py then calls `power.refresh`, since intel_lpmd stops or starts blocking fields).
   Errors keep the last state and go into `lpmd.error`; "rate limited" is retried at the next tick silently.
5. **Charge**: at the first tick of a process, at a set, and 3 s after a resume (suspend_count up or a BOOTTIME jump,
   as power.tick detects them), write each non-null setting that differs, read back; `charge_behaviour` reads like
   `[auto] inhibit-charge inhibit-charge-awake` (the bracketed word is the value). A read that differs from what
   OXP3 Deck last wrote, outside 10 s after a resume → `overridden` for that one (Handheld Daemon and
   steamos-manager write these too), not written again until take_control or a new value.

### Safety

- **Before sleep**: while `fan.ours` is quiet or max, a sleep watch thread holds a logind delay inhibitor
  (`systemd-inhibit --what=sleep --mode=delay --who=OXP3Deck --why="Fan back to Auto before sleep" sleep infinity`,
  through sysexec with its own session) and reads `busctl --system --json=short monitor
  --match=type='signal',sender='org.freedesktop.login1',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'`
  line by line. On `PrepareForSleep(true)`: write `pwm1_enable` 2 (`ours` kept, so the mode comes back), then end the
  inhibitor process (logind waits for it, at most `InhibitDelayMaxSec`). On `PrepareForSleep(false)` (resume): take a
  new inhibitor; the profile's fan mode is written again by the next tick after a 3 s delay. The thread and both
  processes end when the fan goes back to Auto and at unload. If either process cannot start or ends on its own →
  fan Auto (step 2's rule).
- **Unload** (`extras.unload(ctx)`, from main.py `_unload`, in the executor with a 3 s budget: Decky kills the
  process 5 s after asking): fan → `pwm1_enable` 2 when `ours` is set; scx → restore `before`; lpmd → restore when
  paused; stop the sleep watch. Charge settings stay (they are the user's battery choice and are written again at the
  next start). `_uninstall` adds nothing (Decky runs `_unload` first).
- **Errors** in a fan write or read → Auto (above). Every refused value (`inhibit-charge`, a limit outside 50..100, a
  mode outside the lists) → `{ok: false, error}`, nothing written.

### API

```python
def info(ctx) -> dict                    # ExtrasInfoRes: {ok, error, extras: ExtrasState}; cheap (no D-Bus call
                                         # when the cached scx/lpmd state is under 10 s old)
def set_options(ctx, opts) -> dict       # opts: {charge_limit?, charge_behaviour?, lpmd_game_off?} → ExtrasInfoRes;
                                         # validates, saves, applies the charge values at once
def take_control(ctx, what) -> dict      # what: "fan" | "scx" | "charge_limit" | "charge_behaviour" → ExtrasInfoRes;
                                         # clears that override (and fan.reverted) and applies at once
def tick(ctx, active: dict) -> dict      # {ok, error, did: [str], lpmd_changed: bool}
def sync(ctx, active: dict) -> dict      # {ok, error, did: [str], lpmd_changed: bool}
def lpmd_paused(ctx) -> bool             # OXP3 Deck has intel_lpmd in LPM_FORCE_OFF now
def unload(ctx) -> None
```

`power.active(ctx)` (builder 1, power.py, under power's lock, no hardware read but `ac_online`):
`{"key": str, "slot": "main" | "ac", "app": str | None, "ac": bool | None, "enabled": bool, "values": PowerValues}`
(the active profile's stored slot, whether or not TDP control is on). `power.refresh(ctx) -> {ok, error}`: when
`_may_write`, sets `apply_at = now` so the next tick applies (used after an intel_lpmd pause change).

(Built: as above, with these additions. `ExtrasState.charge` gains `error` (the last write error, else null) and
`ExtrasState.scx` gains `note` (a failed switch or restore, or "the scheduler's own arguments could not be put
back; restart scx_loader"). The run file also keeps `fan.held` (the mode a revert or override holds; a different
wanted mode, or after a revert a different profile key, lifts it), and `lpmd.again` / `lpmd.gave_up` (the one
re-pause after a daemon restart). A saved argument that fails the check is not passed: the mode is restored with
`SwitchScheduler(before.sched, before.mode)` and the note is set; a bad scheduler name gets no call at all. The
charge override check reads the two files at most every `CHARGE_CHECK_S = 10` s. The tick's own resume check
(suspend count, BOOTTIME jump) also brings the fan mode back 3 s after a resume when the sleep watch missed it.
`systemctl is-active intel_lpmd.service` runs only while the option is on, something is paused, or `info` asks
(cached 60 s). The sleep watch writes Auto without the module lock (logind waits at most `InhibitDelayMaxSec`).
main.py: `extras_set` / `extras_take_control` answer with `info()` taken after the sync; `_unload` waits
`UNLOAD_EXTRAS_S = 3` s.)

## Automatic launch options

A global toggle "Add needed launch options automatically" (default **off**) plus a per-game override. Frontend only
(the backend never writes launch options), using `launchopts.ts`'s managed keys and `setManaged`, so the user's own
text is never touched.

- **What is needed** comes from the backend: `GameInfo.suggest: {key: ManagedKey, value: string, why: string}[]`, added
  by games.py `_suggest(...)` next to `_advice`, from the same conditions, only when xess-xmx-linux is installed and the
  game's Proton has the hook (`compat_tool_hook` is not false; a system Proton without it gets none):
  - libxess.dll older than 2.0.2.68, libxess_fg.dll older than 1.2, or libxell.dll 1.2.x → `XESS=latest` (one entry;
    `why` names the oldest reason, e.g. "XeSS 1.3.1 is older than 2.0.2.68, so it would run in the slower mode.").
  - an FSR 3.1+ DLL and no XeSS DLL, with xess-xmx-linux 20261104+ (`features.fsr`) → `FSR=xess` ("The game has FSR
    3.1+ and no XeSS: its FSR runs on XeSS.").
  The `advice` lines stay as they are.
  **Never frame generation** (0.4.x, owner report: XESS_FG from the launch options crashed Monster Hunter Wilds):
  `XESS_FG` and `FSR_FG` are never suggested (games.py `NEVER_SUGGESTED`, a final filter in `_suggest`), and
  `autolaunch.plan` and `copyopts` drop them too (`launchopts.NEVER_AUTO`), whatever the backend sends. A game with a
  known `fsr_risk` / `fg_crash` issue gets no `FSR=xess` suggestion either.
- **`src/autolaunch.ts`** (pure, node-tested):
  ```ts
  export type AutoSuggest = { key: ManagedKey; value: string; why: string };
  export type AutoRecord = { added: Partial<Record<ManagedKey, string>>; why: string[]; at: number;
                             done: ManagedKey[]; undone: boolean };
  export type AutoSettings = { on: boolean; games: Record<string, boolean> };    // ui_autolaunch
  export const effectiveOn: (s: AutoSettings | null, appid: string) => boolean;   // games[appid] ?? on ?? false
  export const plan: (text: string, suggest: AutoSuggest[], rec: AutoRecord | undefined) =>
    { text: string; added: AutoSuggest[] };   // adds each key that is absent from managed(parse(text)) and not in
                                              // rec.done; nothing when parse(text).typo; text unchanged when none
  export const undo: (text: string, rec: AutoRecord) => string;   // removes each added key whose value still equals
                                                                  // what was added (a user change is kept)
  export const record: (prev: AutoRecord | undefined, added: AutoSuggest[], now: number) => AutoRecord;
  export const trimLog: (log: Record<string, AutoRecord>, max = 20) => Record<string, AutoRecord>;  // newest `at` kept
  ```
  A key once added (or undone) for a game is in `done` and is never added again, so removing it by hand, or Undo,
  is final.
- **When**: (a) `index.tsx` keeps the previous main app; when it changes away from Steam app X and X is no longer in
  `Router.RunningApps`, after 3 s: `autoApply(X)` (in `src/components/AutoLaunch.tsx`'s module, not a hook):
  `effectiveOn` → `game_info(X)` → `getLaunchOptions(X)` → `plan` → `setLaunchOptions` → `ui_autolaunch_log[X] =
  record(...)` (through `set_setting`, trimmed to 20 games) → toast "Added launch options for <name>: XESS=latest.
  They apply at its next start." (b) Opening a game's controls (Games tab, or the quick panel's last game) while that
  game is **not** running does the same once per mount. **Never while that game runs** (checked right before the
  write, again through `RunningApps`): the row says "Will be added when you quit <name>." A non-Steam app is skipped.
- **UI** (GameControls, under the XeSS options): Dropdown "Add launch options automatically" (options "Use global
  (On)" / "Use global (Off)", "On for this game", "Off for this game"); when the log has an entry not undone: Status
  ✓ "Added: XESS=latest" ⓘ (Details: each `why`, the date, "Applies from the next start.") and ButtonItem "Undo"
  (confirm, then `undo` → `setLaunchOptions`, `undone: true`; refused while the game runs: greyed with "Quit <name>
  first."). The global toggle sits on the Games tab top and in the XeSS tab ("Add needed launch options
  automatically").

## Copy launch options

Owner request: "If launch options can't be set automatically, allow easy copying from the quick menu." In GameControls
(so both the quick panel's "This game" and the Games tab), `components/CopyLaunch.tsx` under the XeSS options. It
never writes launch options.

- **The line** (`copyopts.ts` `copyLine(input) → { line, reason, adds } | null`): the base is the last write Steam
  refused or changed (`setLaunchOptions` not ok: GameControls keeps it as `wanted` until the next read or a write that
  works) → reason `rejected`; else for a non-Steam shortcut or unreadable options the draft picked here (`shortcut`,
  `unreadable`); else Steam's text. Then the `GameInfo.suggest` keys the base lacks (any value, also an unmanaged
  copy, counts as set; keys in the auto log's `done` are skipped: the user removed them) are set with
  `launchopts.setManaged`, so the user's text is kept; with such keys a `current` base becomes `running` (automatic
  on and the game runs: added after it quits) or `advice` (automatic off, or it could not add them). A "%command"
  typo is left as it is. null while reading or when the line is empty. `copyRow` (label, one line) and `copyDetails`
  (what it does and why, where to paste: "<game>'s Properties (the gear on its page) → General → Launch options",
  "Takes effect: Restart the game.", the text field fallback) are there too; the line itself is in the Details as
  Code, and what it adds under "Adds to launch options:".
- **UI**: ButtonItem "Copy launch options ⓘ" in WithDetails, `explainWhen(row.line, EFFECTS["game.copy"])`. Shown
  whenever `copyLine` gives a line, also when nothing is wrong (the user may just want them). The old "Paste these
  launch options" Status stays for shortcut / unreadable, pointing to the button.
- **Clipboard** (`clipboard.ts`): @decky/ui types no Steam call that copies text (only
  `SteamClient.System.CopyFilesToClipboard`, for files), so a chain of web methods, each limited to 1.5 s (a method
  that throws, says false or hangs falls through): `document.execCommand("copy")` on a hidden, read-only textarea in
  the document of the pressed button (`e.currentTarget.ownerDocument`: the Steam UI window, not the plugin's
  SharedJSContext; synchronous inside the press, focus given back afterwards), then
  that window's `navigator.clipboard.writeText` (needs a focused document), then both in the global `document` when
  it is another one. Success: toast title "Copied", body "Paste it into <game>'s Properties → Launch options.". All
  failed: a `TextField` (value the line, `bShowCopyAction`, edits ignored) with "Couldn't copy. Select the line and
  copy it with Steam's keyboard." Which method works in Game Mode is untested on the device.
- Tests: `tests/js/copyopts.test.mjs` (the line and reasons, texts ≤ 60 chars without variable names, Details name
  Properties → Launch options and the tag, the chain's order and fall-through with fake documents, the wiring).

## When it takes effect (effect tags)

Every setting shows when it takes effect, in the short-line style, next to its one line, in its confirm dialog and,
after a change that is not immediate, in a pending row.

- **`src/effects.ts`** (pure, node-tested):
  ```ts
  export type Effect = "now" | "game" | "session" | "reboot" | "idle";
  export type EffectSpec = Effect | Effect[];          // e.g. ["idle", "session"]: "Only while no game runs · Log out…"
  export const EFFECT_TEXT: Record<Effect, string> = { now: "Now", game: "Restart the game",
    session: "Log out of Game Mode or reboot", reboot: "Reboot", idle: "Only while no game runs" };
  export const PENDING_TEXT: Record<Exclude<Effect, "now" | "idle">, string> = { game: "Restart the game to apply",
    session: "Log out of Game Mode or reboot to apply", reboot: "Reboot to apply" };
  export const EFFECTS: Record<string, EffectSpec>;    // the table below, keyed by setting id
  export const effectText: (e: EffectSpec) => string;  // joined with " · "
  export const confirmLine: (e: EffectSpec) => string; // "Takes effect: Restart the game."
  export const fixEffect: (fix: { id: string; takes_effect?: string }) => Effect;   // EFFECTS["fix.<id>"], else from
                                                       // the text: /reboot/ → reboot, /Game Mode starts/ → session,
                                                       // else now
  export const strongest: (es: EffectSpec[]) => EffectSpec;   // reboot > session > game > now ("idle" kept alongside)
  ```
- **Hint.tsx** gains `explainWhen(does: ReactNode, effect: EffectSpec, why?: string | null)`: the one line, then a
  muted (`#9aa4b1`) " · <effectText>"; with `why` (the control is greyed out) the line is `why` instead of `does`, tag
  kept. `explain(does)` stays for read-only rows. The 80-char limit applies to `does` / `why`, not to the tag.
- **Greyed-out controls always say why** (`why`), e.g. "Turn on power control first.", "Locked by Power Profiles.",
  "Only while plugged in.", "Only in the Balanced power mode.", "Quit the game first.", "Needs Linux 7.4 or newer.",
  "Uses the per-core caps." / "Uses the CPU speed cap.", "The scheduler loader isn't running.".
- **Confirm dialogs**: `ConfirmOpts` gains `effect?: EffectSpec`; `confirm` appends a paragraph `confirmLine(effect)`
  after `text`. Every `confirm(` call (and every function returning `ConfirmOpts`: `fixConfirm`, `undoConfirm`, the
  actions.tsx flows) passes one.
- **Pending rows** (`components/Effect.tsx`): `notePending({id, effect, label, appid?})` keeps a small in-memory list
  (store.ts); `<Pending ids={[...]}/>` renders Status rows "Restart <game> to apply" (`game`, with the app's name;
  cleared when that appid starts again, from `onMainAppChange`), "Log out of Game Mode or reboot to apply"
  (`session`; for XeSS the backend's `relogin_needed` is the source instead, and the row goes when it clears), "Reboot
  to apply" (`reboot`; the existing "Reboot to finish" row covers oxp3-tool's `reboot_pending`, so no second row). A
  pending row sits right under the control that caused it; the list is lost when the frontend reloads (the backend
  flags cover the lasting cases). A row for a change made by a job (a fix's log-out) is noted only when that job ends
  `done` (`afterJob(id, fn)` in store.ts), never at its start. A control greyed out because a game runs (the XeSS
  install / update / repair / uninstall buttons, which the backend refuses then) says "Quit <game> first."

| Setting id | Control | Tag |
|---|---|---|
| `power.enable` | Power control (TDP) | Now |
| `power.game_profile` | Separate profile for <game> | Now |
| `power.pl1`, `power.pl2`, `power.gpu_min`, `power.gpu_max`, `power.epp`, `power.turbo` | the sliders and choices | Now |
| `power.reset`, `power.new_profile`, `power.delete_profile` | Reset to device defaults, New / Delete profile | Now |
| `power.per_game`, `power.split_ac`, `power.extended`, `power.poll_s` | Power tab options | Now |
| `power.cpu_max_pct`, `power.soc`, `power.gpu_profile`, `power.cpu_min_pct`, `power.cpu_caps`, `power.epp_split` | new controls | Now |
| `power.take_control`, `power.fix`, `power.unfix`, `power.ignore`, `power.import` | conflict and override buttons, import | Now |
| `extras.fan`, `extras.scx`, `extras.lpmd`, `extras.charge_limit`, `extras.charge_behaviour` | extras | Now |
| `fix.buttons`, `fix.xbox-key`, `fix.volume-keys`, `fix.inputplumber-suspend` | Fixes: Apply / Undo | Now |
| `fix.gyro`, `fix.nvme-resume`, `fix.xe-panel-replay-off`, `fix.xe-hdr-backlight`, `fix.xe-dsb-off` | Fixes: Apply / Undo | Reboot |
| `fix.oled-profile` (and its "Lowest refresh rate") | Fixes | Log out of Game Mode or reboot |
| `fix.nvme-resume.any_ssd` | Apply even without the problem | Reboot |
| `fixes.recommended` | Apply recommended (quick) | `strongest` of the fixes |
| `buttons.layout` (each key, frame limit, Apply layout) | Buttons | Now when "Apply without reboot" is on, else Reboot |
| `buttons.restart` | Apply without reboot | Now |
| `xess.install`, `xess.update`, `xess.repair`, `xess.uninstall` | XeSS | Only while no game runs · Log out of Game Mode or reboot |
| `xess.driver` | Default graphics driver | Restart the game |
| `xess.shim` | Add XeSS to system Protons | Restart the game |
| `xess.remove_folder` | Remove an old folder | Now |
| `game.xess`, `game.fg`, `game.mesa`, `game.vendor`, `game.log`, `game.fsr`, `game.typo` | per-game launch options | Restart the game |
| `game.auto`, `game.auto_undo`, `auto.global` | automatic launch options | Restart the game |
| `game.copy` | Copy launch options (pasted by hand) | Restart the game |
| `kernel.try`, `kernel.keep` | Kernel | Reboot |
| `oxp3.install` | Install / Update fixes tool | Now |
| `reboot` | Reboot to finish | Now |

Selectors that change nothing (Profile to edit, Edit values for, Show 5x–8x, Show advanced CPU options, Show log,
Check again, Refresh, How to fix, Details, Check for update, Save a problem report) carry no tag.

## Interfaces 0.4 (main.py, api.ts, types.ts)

**main.py** (builder 2 owns every main.py edit):

```python
power = _load("power"); readouts = _load("readouts"); extras = _load("extras")   # with the others

async def power_live(self)                    # _mod("readouts").sample(self.ctx)          → PowerLiveRes
async def extras_info(self)                   # _mod("extras").info(self.ctx)              → ExtrasInfoRes
async def extras_set(self, opts)              # _mod("extras").set_options(self.ctx, opts) → ExtrasInfoRes
async def extras_take_control(self, what)     # _mod("extras").take_control(self.ctx, what) → ExtrasInfoRes
```

- `power_options(opts)` now also takes `poll_s`; power_set / power_game / power_profile / power_options /
  power_enable / power_take_control run, in the same executor call after the power call, `self._sync_extras()`:
  `_mod("extras").sync(self.ctx, _mod("power").active(self.ctx))` (and `power.refresh` when it answers
  `lpmd_changed`); any exception there is logged and never changes the power answer. extras_set does the same sync.
- `_power_watch`: each tick `power.tick`, then `extras.tick(ctx, power.active(ctx))`, then `power.refresh(ctx)` when
  `lpmd_changed`. Each in its own try: `Unavailable` of power ends only the power part, of extras only the extras
  part; the loop ends when both are unavailable. A part whose executor step has not finished within `POWER_TICK_S`
  (a hung scx_loader or intel_lpmd: up to about 9 calls of `BUS_TIMEOUT_S = 2` s) is not awaited: the other part goes
  on each pass, and the slow part starts again only once its step has finished (its result is then handled).
- `_unload`: cancel the watch, then `await asyncio.wait_for(loop.run_in_executor(None, _mod("extras").unload,
  self.ctx), 3)` (exceptions and the timeout logged).
- No new settings keys for set_setting (the frontend's are `ui_*`).

**api.ts** (one per line, after power_unfix):

```ts
export const power_live = callable<[], PowerLiveRes>("power_live");
export const extras_info = callable<[], ExtrasInfoRes>("extras_info");
export const extras_set = callable<[opts: Partial<ExtrasOptions>], ExtrasInfoRes>("extras_set");
export const extras_take_control = callable<[what: ExtrasWhat], ExtrasInfoRes>("extras_take_control");
```

**types.ts** additions:

```ts
export type FanMode = "auto" | "quiet" | "max";
export type ScxMode = "auto" | "gaming" | "powersave";
export type GpuPowerProfile = "base" | "power_saving";
export type CoreType = "p" | "e" | "lpe";
// PowerValues gains:
//   cpu_max_pct, cpu_min_pct, soc_balance, soc_offset: number | null; gpu_power_profile: GpuPowerProfile | null;
//   cpu_cap_p_mhz, cpu_cap_e_mhz, cpu_cap_lpe_mhz: number | null; epp_p, epp_e, epp_lpe: Epp | null;
//   fan_mode: FanMode | null; scx_mode: ScxMode | null;
// PowerOptions gains: poll_s: number;                       // 0 = Off, 2..60
// PowerRange gains:
//   cpu_pct_min: number (30); cpu_min_pct_fw: number | null; cpu_min_pct_max: number (50);
//   core_types: Partial<Record<CoreType, { min_mhz: number; max_mhz: number; policies: number }>>;
// PowerInfo.hw gains: cpu.perf_pct: boolean; cpu.types: CoreType[]; soc: boolean; gpu.power_profile: boolean
// PowerState.now gains:
//   cpu_max_pct: number | null; cpu_min_pct: number | null;
//   caps_mhz: Partial<Record<CoreType, number | null>>;      // first policy of each type
//   soc: { balance: number; offset: number; profile: string | null; choices: string[] } | null;
//   gpu_profile: GpuPowerProfile | null;
//   epp_types: Partial<Record<CoreType, Epp | "default" | null>>;
// PowerState gains: blocked_fields: Partial<Record<"epp" | "turbo" | "cpu_pct" | "cpu_caps" | "soc", string[]>>;
// PowerApply.failed[] items gain transient: boolean; PowerOverridden.suspects may hold "other"
export type Live = {
  t: number; package_w: number | null;
  battery: { status: string; percent: number | null; draw_w: number | null; time_left_min: number | null;
             time_to_full_min: number | null } | null;
  cpu_temp_c: number | null;
  gpu: { busy_pct: number | null; cur_mhz: number | null; act_mhz: number | null; reasons: string[] } | null;
  throttle: { cpu_ms: number | null; cpu: boolean; gpu: string[] };
  fan_rpm: number | null;
};
export type PowerLiveRes = Res & { live: Live | null };
export type ExtrasOptions = { charge_limit: number | null; charge_behaviour: "auto" | "inhibit-charge-awake" | null;
                              lpmd_game_off: boolean };
export type ExtrasWhat = "fan" | "scx" | "charge_limit" | "charge_behaviour";
export type ExtrasState = {
  board_ok: boolean; kernel: string;
  charge: { available: boolean; why: string | null; limit: number | null; behaviour: string | null;
            behaviours: ("auto" | "inhibit-charge-awake")[];
            overridden: { limit: string | null; behaviour: string | null } };
  fan: { available: boolean; why: string | null; rpm: number | null; mode_now: FanMode | "manual" | null;
         ours: FanMode | null; reverted: string | null; overridden: string | null; sleep_watch: boolean };
  scx: { shown: boolean; available: boolean; why: string | null; scheduler: string | null;
         mode: "auto" | "gaming" | "powersave" | "lowlatency" | "server" | null; ours: ScxMode | null;
         overridden: string | null };
  lpmd: { shown: boolean; paused: boolean; state: string | null; error: string | null };
  options: ExtrasOptions;
};
export type ExtrasInfoRes = Res & { extras: ExtrasState | null };
// GameInfo gains: suggest: { key: ManagedKey; value: string; why: string }[]
```

`backend.ts` wraps the four new calls like the others (`{ok: false, error, live: null}` / `{..., extras: null}`).
`store.ts`: `useResource("extras-info", extras_info)`, reloaded 2 s after each power or extras change (a fan or scx
change is applied by the sync, so the answer is already fresh; the reload catches lpmd).

## Frontend 0.4 (placement and up-front text)

Quick panel Power section, in order (texts ≤ 80 chars; "→ Details" as in "Up-front text"):

1. "Live" row (always, TDP control on or off).
2. The 0.3 rows.
3. While TDP control is on, after GPU maximum speed: CPU speed cap, CPU vs GPU balance, GPU power saving, CPU
   minimum speed; then ToggleField "Show advanced CPU options" (`ui_power_advanced`, no tag) revealing the per-core
   caps and the per-core energy preference.
4. Always (when available): Fan mode, Scheduler mode, then Battery charge limit, Run from charger.
   intel_lpmd's toggle and the polling rate are on the Power tab only.

0.4.x (owner report "CPU power settings don't seem to affect anything"; the CPU audit found the writes correct
except the turbo clamp above, and the rest hidden or conditional):

- **CPU values in effect** (`power.cpuNowLine`): "Cap 60 % · Min 9 % · Energy: Balance power · Boost: off · Balance 4
  (balanced)": the Power tab's CPU row (sysfs names in its Details) and, in the quick panel, a "CPU now" row under
  CPU boost.
- **CPU minimum on battery**: on the active profile while on battery the line says "On battery: the device's own
  floor (9 %) runs now." on both pages (the slider is disabled only in the quick panel).
- **Paused**: while `state.blocked` (thermald came back), the profile editor starts with "Paused: Changes are saved
  and apply once the other program stops."
- **`performance` governor**: a red row up front, "CPU speed policy is Performance: energy preference and minimum
  speed don't apply; the CPU runs at its cap." (Details: "A reboot or the desktop's power settings reset it.";
  SimpleDeckyTDP's governor setting can leave it so; OXP3 Deck does not change it).
- **Speed cap Details**: "With CPU boost off the cores stop at their base speed, so a high cap changes nothing.", and
  when it shows at all (CPU-heavy games slow down; GPU-bound games at the power limit barely move). The minimum's
  Details: it shows mostly at idle.
- **Left to another program**: `state.yielded` (Drift, above).

The Power tab shows the same controls in its profile editor (they edit the chosen profile and slot; extras' global
options in a new "Battery" section, the intel_lpmd toggle under "Other power programs", "How often to check" under
Control) and a "Live readouts" section after Status.

| Row | Label | One line (up front) | Tag | → Details |
|---|---|---|---|---|
| Live (quick) | "Live" ⓘ | `liveLine`: "18.4 W · 62 °C · GPU 87 % · 3 h 10 min left" | — | every readout, requested vs running GPU clock, why it is slow, fan RPM; Technical: energy_uj, gtidle, coretemp, thermal_throttle |
| CPU speed cap | "CPU speed cap" | "Lower leaves more power for the GPU in GPU-heavy games." / greyed: why | Now | 30–100 % of each core's top speed; suggested 60–70 % on battery; steadier frame pacing at a fixed TDP is likely but unmeasured; resets at reboot; Technical: intel_pstate/max_perf_pct |
| CPU vs GPU balance | "CPU vs GPU balance" | "Hint to the chip: favour the CPU (1) or the GPU (5)." / greyed "Only in the Balanced power mode." | Now | 3 = device default; works only while the power mode is Balanced; power-profiles-daemon's Balanced uses it too; effect not measured; Technical: slider_balance (+ slider_offset), platform-profile "SoC Power Slider" rewritten to balanced |
| Slider offset (Power tab) | "Let the chip save more" | "Lets the firmware lean towards saving power by up to this much." | Now | 0–3, the firmware may move the balance up by this; Technical: slider_offset |
| GPU power saving | "GPU power saving" | "GPU speeds up more slowly. Good with a frame limit." | Now | can stutter in uncapped heavy games; render GPU only; resets at reboot, OXP3 Deck sets it again; Technical: freq0/power_profile base / power_saving |
| CPU minimum speed | "CPU minimum speed (plugged in)" | "Higher reacts faster, uses more power." / greyed "Only while plugged in." | Now | from the device's own floor (<n> %) to 50 %, never above the speed cap; on battery the device's floor is used; Technical: intel_pstate/min_perf_pct |
| Advanced toggle | "Show advanced CPU options" | "Caps and energy preference per core type." | — | — |
| Per-core caps | "Performance cores max" / "Efficient cores max" / "Low-power cores max" | "Limit these cores' top speed." / greyed "Uses the CPU speed cap." | Now | MHz, step 100; either this or the speed cap (switching asks first: confirm "Use per-core caps?" text "This turns off the CPU speed cap." / "Use the CPU speed cap?" text "This turns off the per-core caps."); Technical: policyN/scaling_max_freq, cpu_core / cpu_atom |
| EPP split | "Energy preference: performance cores" / "…: efficient cores" / "…: low-power cores" | "Same as above" option first; "How eagerly these cores speed up." / greyed "Locked by <name>." | Now | gain is small and unmeasured; Technical: energy_performance_preference per policy |
| Fan mode | "Fan" | "Auto, Quiet or Max. Quiet goes back to Auto if the CPU gets too hot." / reverted: the reason | Now | Quiet ≈ 40 %; Quiet back to Auto at 90 °C (Max stays), on any error, before sleep and when OXP3 Deck stops; needs Linux 7.4; Handheld Daemon's fan control fights it; Technical: oxp_ec pwm1_enable / pwm1 |
| Fan overridden (red) | "Something else changed the fan" | "Likely Handheld Daemon. Turn its fan control off, then Take control." | Now | — |
| Scheduler mode | "CPU scheduler mode" | "Gaming favours the game; Power save saves battery." / greyed why | Now | CachyOS's LAVD scheduler through scx_loader; per profile; CachyOS's power switch may change it too (then OXP3 Deck stops and says so); Technical: org.scx.Loader SwitchScheduler, scx_lavd --performance / --powersave / --autopilot |
| intel_lpmd (Power tab) | "Pause Intel's low-power daemon in games" | "Stops it moving the game to slow cores while a game runs." | Now | only while it runs; it reverts when the daemon restarts; Technical: LPM_FORCE_OFF / LPM_AUTO on org.freedesktop.intel_lpmd |
| Charge limit | "Battery charge limit" | "Stops charging at this level. Slows battery wear when often plugged in." | Now | 50–100 % (100 = charge fully); needs Linux 7.4; Handheld Daemon and Steam may also set it; Technical: charge_control_end_threshold |
| Charge behaviour | "Run from charger (battery idle)" | "While awake and plugged in, the battery is left alone." | Now | less heat when docked; charges normally while asleep; never "inhibit-charge"; Technical: charge_behaviour inhibit-charge-awake / auto |
| Battery note (Power tab) | "Battery and fan controls" | "Need Linux 7.4 or newer (this is <release>)." | — | the kernel versions |
| Polling (Power tab) | "How often to check" | "How often OXP3 Deck checks your settings are still in place." | Now | Off: only after a game change, the charger or sleep; it retries what didn't take (GPU busy) but never fights another program |
| Auto launch (global) | "Add needed launch options automatically" | "Adds what XeSS needs for a game. Never changes your own text." | Restart the game | applies from the next start; never while the game runs; Undo per game; what it may add (XESS=latest, FSR=xess) and when |
| Auto launch (per game) | "Add launch options automatically" | "Use global (On)" / "On for this game" / "Off for this game" | Restart the game | as above |
| Auto added | "Added: XESS=latest" ✓ ⓘ | "Applies from the next start." | Restart the game | each why, date |
| Auto waiting | "Will be added when you quit <name>" | the keys | — | — |

The "Added: XESS=latest" row is the one place a launch-option variable shows up front: it names exactly what was
written, which the Undo next to it removes (an exception to "no env variables in one-liners", made here).

(Built, frontend: extra tag ids `power.soc_offset`, `extras.take_control`, `buttons.layout_reboot` (Apply layout with
"Apply without reboot" off) and `fix.oled-profile.min_refresh`; `effects.ts` also has `effectOf` and `pendingText`.
"Reset to device defaults" writes every field null but `fan_mode` / `scx_mode` (`power.ts` `RESET`). The speed cap and
the per-core caps grey each other out ("Uses the per-core caps." / "Uses the CPU speed cap."); the switch is a button
under the greyed one ("Use the CPU speed cap instead" / "Use per-core caps instead"), confirm, then one change
(`toPct(null)` / `toCaps({})`). CPU minimum speed is greyed "Only while plugged in." in the quick panel only (the Power
tab edits the AC value from battery too). The charge limit and the polling rate are sent 400 ms after the last slider
move. `autolaunch.ts` inserts and removes the one token in place (never re-joining the user's text; game arguments
without `%command%` only when they need no re-quoting), keeps the log under the 4096-byte setting limit (`fitLog`), and
`steam.ts` `isRunning` answers true when Steam cannot tell. Node tests load `src/*.ts` files with runtime imports
through `tests/js/tsresolve.mjs` (an extensionless-import resolve hook). New `PowerRange` / `hw` / `now` fields are
optional in types.ts, for an older backend.)

## Tests 0.4

**Builder 1** (`tests/powerfake.py` grows `perf(ctx, max=100, min=9)`, `types(ctx, p="0-3", atom="4-11",
no_l3=(8, 9, 10, 11), max_khz=..., min_khz=...)` (affected_cpus, cpuinfo_*, scaling_max/min_freq per policy),
`soc(ctx, balance="03", offset="00", profile="balanced", name="SoC Power Slider")`, `gpu_profile(ctx, value="base")`,
`energy(ctx, uj, max_uj)`, `coretemp(ctx, milli=62000, label="Package id 0")`, `gtidle(ctx, ms)`,
`throttle(ctx, ms)`, `oxp_ec_fan(ctx, rpm)`):
- test_powerhw: core types (P / E / LP-E by L3; not hybrid → all p; a CPU in neither list); the SoC device found by
  name among two platform-profile devices, none when the name differs or a param is missing; hex read/write `"04"`;
  perf order (raising writes max first, lowering min first; recorder order); caps clamp to scaling_min_freq and
  tolerance; soc writes offset, balance, then `balanced` only when it reads balanced (with `performance`: params
  written, the profile file untouched, no failure); never writes `performance`, `low-power`, `custom`, the legacy
  file, `scaling_min_freq` (no recorded path); gpu power_profile `[base]    power_saving` parsing, EIO → failed
  transient, read-back mismatch → transient; `read(gpu=False)` still opens no min/max/act/cur file.
- test_power: new fields' bounds and nulls; mutual exclusion refused, nothing saved; `cpu_min_pct` applied on AC
  only (battery writes the snapshot floor), clamped under the cap; EPP split dict per policy, `ours` per type;
  snapshot gains keys, an old snapshot without them gets them filled (not retaken); restore writes them back in
  order; drift on `cpu/max_pct` → overridden with suspects (lpmd active → intel_lpmd; none → "other"); a
  power-profiles-daemon profile switch is not drift; `FIELD_BLOCKERS` (ppd blocks epp/turbo but not cpu_pct/soc;
  intel_lpmd blocks cpu_pct, caps, soc; with `extras.lpmd_paused` patched true it blocks none); `poll_s`: 0 →
  no drift check outside grace, 10 → one check every 5 ticks, grace still every tick, pending transient ids retried
  and cleared; `power_options({poll_s: 1})` and `61` refused; `active()` shape with per_game / split_ac;
  `refresh()` sets apply_at only when writing is allowed; fan_mode / scx_mode stored and copied, never written.
- test_readouts: package W from two samples, wrap with `max_energy_range_uj`, first sample null, MMIO zone ignored;
  battery power_now and current×voltage, time left / to full; coretemp by name with a second hwmon of another name
  first; GPU busy from idle residency; throttle delta; fan RPM only with oxp_ec; a tree with nothing → every value
  null, `ok: true`.

**Builder 2** (`tests/extrasfake.py`: DMI board_name, oxp_ec hwmon with `pwm1_enable`/`pwm1`/`fan1_input`, battery
with `charge_control_end_threshold` and `charge_behaviour` in the bracketed form, `/sys/kernel/sched_ext`, and a
fake `sysexec.run` answering `busctl` and `systemctl is-active` from tables and recording argv):
- gates: board `ONEXPLAYER 3` + oxp_ec + files → available; `ONEXPLAYER 3 EVA` or missing oxp_ec → not, with the
  why; scx hidden without sched_ext, greyed for `unknown` / `scx_bpfland`; lpmd hidden when inactive.
- charge: 49 / 101 / `inhibit-charge` refused, nothing written; written and read back; re-applied after a resume;
  hhd-style change → overridden; take_control clears it.
- fan: quiet writes 1 then 102; max writes 0; quiet at 90 °C → 2 and not re-applied until a change; max at 90 °C
  stays; unreadable temperature →
  2; write error → 2; pwm1_enable read 2 while quiet → overridden; unload writes 2; the sleep watch: a fake
  monitor line `PrepareForSleep(true)` writes 2 and ends the inhibitor, `false` takes a new one, the next tick
  re-applies; a watch that cannot start → Auto with the reason.
- scx: argv exactly as in "The D-Bus APIs" (`--auto-start=no` on every call; no `StartScheduler`, `StopScheduler`);
  the mode set when the profile asks and the loader runs scx_lavd; restore with mode, or with args when they were
  non-empty; a bad arg or name not restored; mode changed by someone else → overridden, no more calls.
- lpmd: pause only with the option on, the service active and a game; `OFF` already → no call; restore
  LPM_AUTO / LPM_FORCE_ON by `before`; "rate limited" retried next tick; at most one privileged call per tick;
  `lpmd_paused` follows; `lpmd_changed` set on each change; a daemon restart re-pauses once.
- games.py `suggest`: XeSS 1.3 → XESS=latest; XeLL 1.2 → XESS=latest (one entry); FSR-only with 20261104 → FSR=xess,
  without → none; not installed or a hook-less Proton → none.
- test_main: `CALLS` gains `"power_live": ()`, `"extras_info": ()`, `"extras_set": ({"lpmd_game_off": True},)`,
  `"extras_take_control": ("fan",)`; the signature test covers the `_mod("readouts")` / `_mod("extras")` calls; the
  watch loop runs extras.tick after power.tick, calls power.refresh on `lpmd_changed`, survives a raising extras and an
  unavailable one, and keeps ticking power while an extras step hangs; `_unload` calls extras.unload within 3 s; power_set's answer is unchanged by a raising sync.
- test_package: `extras.py` and `readouts.py` in the zip listing.

**Builder 3** (node tests, no new dependencies):
- `tests/js/effects.test.mjs`: every id the frontend uses is in `EFFECTS` (ids read from `src/**/*.tsx` by the
  `effect=` / `EFFECTS["…"]` pattern); `fixEffect` for each fixture fix id and for an unknown one by its text;
  `strongest`; `confirmLine`.
- `tests/js/autolaunch.test.mjs`: `plan` adds absent keys only, keeps the user's text byte for byte apart from the
  added tokens, skips `done` keys, does nothing on a typo; `undo` removes only unchanged added keys; `trimLog` keeps
  the 20 newest; `effectiveOn`.
- `tests/js/live.test.mjs`: `liveLine` drops nulls and stays ≤ 80 chars; `whySlow`.
- `tests/js/power.test.mjs`: `FIELDS` and `EMPTY` have the 19 names; the index slider of `POLL_STEPS`.
- `tests/js/pages.test.mjs`: every `<ToggleField`, `<SliderField`, `<DropdownItem` in `src/` (up to its `/>`) has
  `explainWhen(` in its props, except the selectors listed above (by label); every `confirm(` call's object has
  `effect`; `fixConfirm` / `undoConfirm` results have `effect`; `setLaunchOptions(` in AutoLaunch.tsx is preceded by a
  running check in the same function; `power_live(` is only called from `useLive`; `extras_set(` never sends
  `"inhibit-charge"` (the only behaviour values in src/ are `auto` and `inhibit-charge-awake`).

On the device (owner, after the build): max_perf_pct 70 at 25 W in a GPU-bound game (FPS, package W); slider 1 vs 5
at a fixed PL1 (A/B); power_saving with a 40 FPS cap (W); min_perf_pct 50 on AC (feel, idle W); the Live row against
`turbostat` / `intel_gpu_top`; polling Off then Steam's TDP slider (no drift line until the panel opens); on 7.4:
charge limit 80 %, Run from charger (battery current ≈ 0 while gaming plugged in), Quiet fan (RPM, temperature,
back to Auto at 90 °C, before sleep and on plugin reload); scx mode Gaming in a game and back after it; intel_lpmd
paused while a game runs (`GetState` OFF) and back.

### Tests 0.4.x (owner report: CPU, scheduler, XeSS frame generation)

- `tests/powerfake.py`: `types()` writes a per-policy `base_frequency` (`base_khz`, P 2000 / E 1800 / LP-E 1200 MHz),
  and `Writer` models intel_pstate's turbo clamp: with `no_turbo` 1 a policy's `scaling_max_freq` reads
  min(the request, `base_frequency`), the request comes back with turbo on (only for policies with that file).
- test_power `TurboClampTest`: boost off leaves `failed == []` and no override over ticks; boost off then a change
  that writes nothing answers `ok`; per-core caps stop at base with boost off and come back with it on; TDP control
  off restores the boot caps. `IgnoredCpuDaemonTest`: an ignored power-profiles-daemon rewriting EPP → `yielded
  ["epp"]`, no override, power limits still apply; a speed cap drift is still an override. NewDriftTest: an ignored
  intel_lpmd gets the slider back (`yielded ["soc"]`), a change takes it again; a GPU profile drift is an override.
- test_games `KnownIssuesTest` (MH Wilds `fg_crash`, `has_fg` false, only XESS=latest suggested; every issue has a
  source and a ≤ 80 line), `NeverFrameGenerationTest` (no XESS_FG / FSR_FG suggested for any DLL mix, no FSR for MH
  Wilds, the final filter), `PrefixChecksTest` (capitalised DriverStore with a stock link → row, a shim there → none,
  lowercase only → none; HideWineExports with XeLL and the fullscreen log line → rows; advice wording).
- node: `plan` and `copyLine` drop XESS_FG / FSR_FG; `releaseRows`; `cpuNowLine`, `yieldedText`, the governor text;
  source checks for the scheduler warning and confirm, the frame generation confirm and rows, the Paused row.

## Builders 0.4 (who owns which file)

| Builder | Owns (creates or edits) | Must not edit |
|---|---|---|
| 1 backend power | `py_modules/oxp3deck/power.py`, `powerhw.py`, new `readouts.py`; `tests/powerfake.py`, `tests/test_power.py`, `tests/test_powerhw.py`, new `tests/test_readouts.py`, `tests/fixtures/power/` | main.py, extras.py, games.py, src/ |
| 2 backend extras | new `py_modules/oxp3deck/extras.py`; `games.py` (`suggest`); **all of `main.py`** (incl. `power_live`); new `tests/extrasfake.py`, `tests/test_extras.py`; `tests/test_games.py`, `tests/test_main.py`, `tests/test_package.py`; CREDITS.md (scx-loader and intel-lpmd named as API sources, GPL-2.0, no code copied) | power.py, powerhw.py, readouts.py, src/ |
| 3 frontend | everything under `src/` (types.ts, api.ts, backend.ts, store.ts, power.ts, new effects.ts, autolaunch.ts, live.ts, components/Effect.tsx, CpuControls.tsx, LiveRows.tsx, ExtrasControls.tsx, AutoLaunch.tsx, every page and component for tags and greyed-out whys); `tests/js/*`; README.md (new controls, tags, auto launch options) | anything in py_modules, main.py, tests/*.py |

Interfaces between them are exactly the signatures above: builder 2 may stub `power.active` / `power.refresh` /
`readouts.sample` in its tests until builder 1's land; builder 1 reads `extras.lpmd_paused` lazily (missing →
False). DESIGN.md belongs to the integrator; a builder writes "(Built: …)" notes into its own sections only.
