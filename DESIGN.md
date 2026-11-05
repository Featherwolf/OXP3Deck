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
  run as root by the backend. The plugin is a front end. The one exception is power control (power.py,
  powerhw.py), which writes sysfs itself; its writes are not jobs and no job ever blocks them.
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
- **Every control explains itself** in its own `description` (the D-pad scrolls it into view), and every action
  shows its result or its error in a row under the control.

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
  powerhw.py           power sysfs only: RAPL (MSR and MMIO), the xe GPU clock range, EPP, turbo, AC, suspend count
  power.py             power control: profiles (power.json), the boot snapshot and run state, events, drift, conflicts
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
  pages/, components/  the quick panel, the full page's tabs (pages/Power.tsx), shared rows (Hint, JobView,
                       GameControls, PowerControls, ...)
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
override; for this boot only). Nothing inside the plugin folder (an update deletes it).

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
}
```

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

## Power (TDP, GPU, CPU)

Power control built into OXP3 Deck: sustained (PL1) and boost (PL2) power limits, the Arc GPU's clock range, the CPU's
energy-performance preference (EPP) and turbo, with a default profile, per-game profiles and optional separate AC
values. It replaces SimpleDeckyTDP, which on Panther Lake writes one value to every constraint (PL1 = PL2 = PL4), only
to `intel-rapl-mmio`, cannot set the xe GPU clocks and caps the range at 40 W.

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
  refused while another power manager is active (Conflicts). The user stays the one who resolves a conflict: OXP3
  Deck never stops, disables or masks another service and never edits another plugin's settings.
- **Write only what is ours to write**: PL1 (`long_term`) and PL2 (`short_term`) of every `package-*` zone of
  `intel-rapl` and `intel-rapl-mmio`; `min_freq` / `max_freq` of the render GT; `energy_performance_preference` of
  every cpufreq policy; `intel_pstate/no_turbo`. Never PL4 (`peak_power`), never `psys`, `core`, `uncore` or `dram`
  zones, never a zone's `enabled` (writing it changes PL2's enable and clamp bits too), never `time_window_us`, never
  the media GT, never `power_profile`, the governor, `intel_pstate/status`, `platform_profile` or SMT.
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
- **Limits stay on plugin unload and uninstall**: `_unload` and `_uninstall` write nothing. A plugin reload or update
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
  6. Every `CONFLICT_RECHECK_S`: the conflict check; a non-ignored blocker that appears while enabled → `blocked`.
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
- `suspects`: for a RAPL or `gpu/*` item the active "blocks" conflicts (ignored ones too), for `epp` / `turbo` the
  "cpu" ones; none → `["steam"]`.
- The UI shows the red line "Something else changed the power limits (now 35 W, OXP3 Deck set 15 W). Likely: <names>."
  with the guidance of each suspect and a "Take control again" button. "steam" reads: "Steam's own Performance
  settings: in Quick Access → Performance, turn off "TDP limit" and "Manual GPU clock"."

### Conflicts

`conflicts(ctx)` runs `systemctl list-units --all --type=service --plain --no-legend --no-pager` once through
`sysexec.run` (timeout 10 s), takes the first column and the ACTIVE column (`active`/`activating`/`reloading` =
active), reads `/proc/*/comm` for programs started without systemd, and looks at Decky's plugins: each
`<homebrew>/plugins/*/plugin.json`'s `name` (`homebrew` = the folder two above `ctx.settings_dir`, read with
`context.read_small`), enabled unless it is in `<homebrew>/settings/loader.json`'s `disabled_plugins` list.

| id | Detected by | kind | ignorable | Guidance (`fix`) |
|---|---|---|---|---|
| `simpledeckytdp` | Decky plugin "SimpleDeckyTDP", enabled | blocks | no | Decky → Settings → Plugins: disable or uninstall SimpleDeckyTDP (Power tab → Import first) |
| `powercontrol` | Decky plugin "PowerControl" or "PowerTools", enabled | blocks | no | same, for that plugin |
| `powerstation` | `powerstation.service` active, or comm `powerstation` | blocks | no | `sudo systemctl disable --now powerstation.service` (Bazzite: Steam's TDP slider uses it; if it is back after a reboot, `sudo systemctl mask powerstation.service`) |
| `thermald` | `thermald.service` active, or comm `thermald` | blocks | no | `sudo systemctl disable --now thermald`: on Panther Lake it rewrites PL1 within seconds. The SoC's own thermal limit and the fan curve still protect the device |
| `hhd` | `hhd@*.service` / `hhd.service` active, or comm `hhd` | blocks | **yes** | turn off TDP control in Handheld Daemon's settings, then "I have done that" (adds it to `ignore`) |
| `oxp3-tdp-sync` | `oxp3-tdp-sync.service` active | blocks | no | `sudo systemctl disable --now oxp3-tdp-sync.service` (it copies MMIO PL1 into MSR every 2 s; OXP3 Deck writes both) |
| `onex3-tdp` | `onex3-tdp.service` active | blocks | no | `sudo systemctl disable --now onex3-tdp.service` |
| `steamos-remote` | a file in `/etc/steamos-manager/remotes.d/` or `/usr/share/steamos-manager/remotes.d/` containing `TdpLimit1` | blocks | yes | Steam's TDP slider writes through it: turn Steam's "TDP limit" off, or remove that file |
| `ppd` | `power-profiles-daemon.service` active | cpu | yes | `sudo systemctl disable --now power-profiles-daemon` |
| `tuned` | `tuned.service` or `tuned-ppd.service` active | cpu | yes | `sudo systemctl disable --now tuned tuned-ppd` |
| `intel_lpmd` | `intel_lpmd.service` active | cpu | yes | `sudo systemctl disable --now intel_lpmd` (CachyOS enables it on Panther Lake; it sets EPP and parks cores, not RAPL) |

- **blocks**: `enable(true)` answers `{ok: false, error: "another power manager is active: PowerStation", state}` and
  writes nothing; one appearing while enabled sets `state.blocked` and writes stop (nothing is restored: the other
  manager is in charge now). An ignored ignorable one does not block.
- **cpu**: power limits and GPU work; EPP and turbo are not written (`state.cpu_blocked` says why, the EPP and turbo
  controls are disabled with that text) unless the id is in `ignore`.
- Each answer row: `{id, name, kind, ignorable, ignored, why, fix}`; only active ones are listed. A failing
  `systemctl` gives one row `{id: "unknown", kind: "suspect", ...}` ("could not list services: ...") and blocks
  nothing.

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
};
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
  cpu_blocked: string | null;             // why EPP and turbo are not written
  last: PowerApply | null;                // the last apply
};
export type PowerInfo = {
  hw: { rapl: boolean; mmio: boolean; gpu: { card: string; gt: string; media_gt: string | null } | null;
        cpu: { pstate: string | null; epp_choices: Epp[]; turbo: boolean } | null;
        ac_supply: string | null; problems: string[] };
  options: PowerOptions;
  profiles: Record<string, PowerProfile>;  // "default" always present
  conflicts: PowerConflict[];
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
focusable with the D-pad, each with its description:
1. Status line: `effectiveLine` and the active profile ("Cyberpunk 2077 · on AC" / "Default · on battery").
2. Red rows when relevant: `blocked` (with the conflict's fix), `overridden` (the drift text and a "Take control
   again" button), failed items of `last`, and every locked limit from `now.zones[].locked` (which lasts the boot,
   while an apply skips a locked id): "MSR PL1 is locked by firmware at 25 W: the limit cannot go above 25 W (the
   CPU uses the lower of the two)". The cached `power-info` (the conflict rows the fixes come from) reloads when
   `blocked` or `overridden.since` changes.
3. Toggle "TDP control". The first enable shows a confirm: what is written, that "off" restores the firmware values,
   that a reboot does too. A refused enable shows each blocking conflict's name and fix under the toggle.
4. When enabled:
   - Toggle "Profile for this game" (only while a game runs and `per_game`): on → `power_profile(appid, name, true)`
     (copy of the default), off → delete (confirm).
   - Slider "Sustained power" (PL1, `pl1_min..pl1_max`, step 1 W, " W"). Its description names the profile it edits.
   - Slider "Boost power" (PL2, `max(pl1, pl1_min)..pl2_max`, step 1 W). Moving PL1 above PL2 moves PL2 with it in
     the same change.
   - Slider "GPU max clock" (`gpu_min..gpu_max`, step 50 MHz, notch label "efficient" at `gpu_efficient`).
   - Toggle "CPU boost" (turbo; disabled with `cpu_blocked` as its description).
   - EPP, GPU min, AC/battery split, the extended range and every profile live on the full page only.
   - Each slider shows the firmware value while its field is null; the description says "(firmware value)".
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
4. Conflicts: every active one with its fix, Ignore for an ignorable one ("I have done that"), "Check again"
   (`power_info(true)`).
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

**`tests/test_main.py`**: the nine calls in `CALLS` (e.g. `"power_set": ("default", "main", {"pl1_w": 15})`);
`Base.setUp` also sets `power` to `Raising()`; `_main` starts the watch task and `_unload` cancels it (no task left);
a raising `tick` does not end the loop; power calls answer while a job runs; the overview answers with a raising power
module (`power: null`). The signature test covers the `_mod("power")` calls.

**`tests/js/power.test.mjs`**: `makeWriter` with fake timers (trailing send, one in flight, merged pending, order,
stale answer ignored, flush), `editSlot`, `shown`, `pl2Floor`, `clampW`, `effectiveLine`.
**`tests/js/pages.test.mjs`**: `index.tsx` registers `onMainAppChange` and calls its stop in `onDismount`;
`PowerControls.tsx` never calls `power_set(` inside an `onChange` (only the writer); `Quick.tsx` renders
`<PowerSection` before the oxp3-tool section; `Full.tsx` has the Power tab.
**`tests/test_package.py`**: `power.py` and `powerhw.py` in the zip listing.

On the device (owner, after the build): MSR and MMIO read-back under load (`act_freq` 2300 MHz at 35 W with
`reasons` none), AC unplug and plug (MMIO reset re-applied), suspend and resume, a game switch, Steam's TDP slider
flagged as drift, `enable(False)` back to 25/52 and 35/52 W.

### Docs and credits

- DESIGN.md: Layout gets `powerhw.py`, `power.py`, `src/power.ts`, `components/PowerControls.tsx`, `pages/Power.tsx`,
  `tests/powerfake.py`, `tests/test_powerhw.py`, `tests/test_power.py`, `tests/js/power.test.mjs`,
  `tests/fixtures/power/`; "State the plugin keeps" gets `power.json` and `/run/oxp3deck/power-run.json`; Frontend
  gets the Power section and tab (pointing here).
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
