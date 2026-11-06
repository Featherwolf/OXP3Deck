import type { ManagedKey } from "./launchopts";

// The backend's answers, as DESIGN.md "Backend API" defines them. Oxp3Status, Oxp3Catalog and Oxp3Kernel are
// oxp3-tool's own --json objects (oxp3_tool/cli.py status_data / catalog_data, kernel_cmd.py describe_data).

/** Every backend result carries these two. */
export type Res = { ok: boolean; error: string | null };

export type Oxp3Install = {
  installed: boolean; path: string | null; version: string | null; json_ok: boolean;
  min_version: string; bundled_version: string | null;
};

export type XessSummary = {
  installed: boolean; version: string | null; status: "ok" | "failed" | "unknown"; line: string | null;
  live: boolean; relogin_needed: boolean;
};

export type Job = {
  id: string; kind: string; title: string; state: "running" | "done" | "failed";
  started: number; ended: number | null; log: string[]; result: any; error: string | null;
};
export type JobStart = Res & { job: Job | null };

export type Overview = Res & {
  plugin_version: string;
  user: string; home: string;
  platform: "cachyos" | "bazzite" | null;
  device: { vendor: string | null; product: string | null; supported: boolean };
  oxp3: Oxp3Install;
  xess: XessSummary;
  job: Job | null;
  reboot_pending: boolean;
  do_not_reboot: string | null;
  power?: PowerSummary | null;               // null: the power module did not answer
};

// ---- oxp3-tool -----------------------------------------------------------------------------------------------------

export type FixState = "applied" | "damaged" | "recommended" | "optional" | "experimental" | "n/a" | "reverting"
  | "incomplete" | "unknown";

export type Oxp3Fix = {
  id: string; group: "controller" | "display"; level: "recommended" | "optional" | "experimental";
  title: string; summary: string; takes_effect: string; state: FixState;
  notes: string[]; applied_at: string | null; options: Record<string, any>;
  pending: "reboot" | "inputplumber-restart" | null;
};

export type Oxp3Status = {
  device: { vendor: string | null; product: string | null; bios: string | null; supported: boolean };
  os: { name: string | null; platform: "bazzite" | "cachyos" | null; handheld: boolean; image: string | null;
        kernel: string | null };
  boot: string; secure_boot: boolean; can_change: boolean; needs_root: boolean; game_mode: boolean;
  game_mode_input: "ogui" | "steam" | null; warnings: string[]; notes: string[]; fixes: Oxp3Fix[];
  reboot_pending: boolean; rebuild_unfinished: string | null;
  refresh: { summary: string[]; advice: string[] } | null; text: string;
};

export type Oxp3CatalogFix = {
  id: string; group: "controller" | "display"; level: "recommended" | "optional" | "experimental";
  title: string; summary: string; details: string; takes_effect: string;
};
export type ButtonKey = "onex" | "keyboard" | "home" | "xbox";
export type Oxp3Catalog = {
  fixes: Oxp3CatalogFix[];
  button_actions: Record<string, string>;
  button_keys: Record<ButtonKey, { label: string; default: string; stock: string; flag: string }>;
  fps_limit: { min: number; max: number; default: number };
  min_refresh: { min: number; max: number; default: number };
};

export type Oxp3KernelEntry = {
  package: string; release: string; running: boolean; entry: string | null; usable: boolean; default: boolean;
};
export type Oxp3Kernel = {
  conf: string; kernels: Oxp3KernelEntry[];
  next_boot: { package: string | null; why: string; then: string | null };
  remember_last_entry: boolean; trying: boolean; notes: string[];
};

export type ApplyOpts = {
  home?: string; keyboard_key?: string; onex_key?: string; xbox_key?: string;
  fps_limit?: number; min_refresh?: number; any_ssd?: boolean; no_restart?: boolean;
};

export type StatusRes = Res & { status: Oxp3Status | null };
export type CatalogRes = Res & { catalog: Oxp3Catalog | null };
export type PlanRes = Res & { plan: string[]; log: string[] };
export type KernelRes = Res & { kernel: Oxp3Kernel | null };
export type Oxp3UpdateCheck = Res & {
  installed: string | null; bundled: string | null; online: string | null; online_commit: string | null;
  update: "bundled" | "online" | null;
};

// ---- xess-xmx-linux ------------------------------------------------------------------------------------------------

export type XessDriver = { version: string; default: boolean };
/** ~/.cache/xess-xmx/driver-status's first line, in every form tools/session-check.sh writes (xess.parse_status). */
export type XessStatus = {
  state: "ok" | "failed" | "unknown"; line: string | null; driver: string | null; notes: string[];
  date: string | null; lib: string | null; driver_info: string | null; reason: string | null; switched_to: string | null;
};
export type XessState = {
  installed: boolean; package_dir: string | null; version: string | null;
  found_by: "env" | "check-unit" | "settings" | null;
  managed: boolean;
  package_dir_kept: string | null;         // why the XeSS tab will not remove package_dir once it is old (RC-2), or null
  drivers: XessDriver[]; preferred_driver: string | null;
  status: XessStatus;
  live: boolean;
  steam_running: boolean;
  relogin_needed: boolean;
  units: { check: string | null; watcher: string | null };
  system_protons: { path: string; name: string; shimmed: boolean; stock: boolean }[];
  system_protons_need_shim: boolean;
  user_protons: { name: string; path: string; shimmed: boolean; hook: boolean }[];
  missing_tools: string[];
  old_folders: string[];                   // earlier package folders the XeSS tab can remove (after a re-login)
  old_folders_kept: { path: string; why: string }[];   // earlier ones it leaves to the user: a git checkout, ...
  flatpak_steam: boolean;
  latest: string | null;                   // from the last update check; null unless newer than the installed package
  update_available: boolean;               // latest is set and something is installed
  checked_at: number | null;
  missing_downloads: string[];             // "igc", "xess", "ffx": the package's get-<piece>.sh exists, its files not
  repair: string | null;                   // install.sh should run again in this folder (same release), and why
  script_running: string | null;           // a package script an earlier plugin process started, still running
  features: { fsr: boolean; alt_driver_store: boolean };
};
export type XessStateRes = Res & { xess: XessState | null };
export type XessUpdateCheck = Res & {
  installed: string | null; latest: string | null; update_available: boolean; checked_at: number; note: string | null;
};
export type DriversRes = Res & { drivers: XessDriver[]; output?: string[] };
export type ShimRes = Res & { done: string[]; failed: string[]; already: string[]; notes: string[] };

// ---- per game ------------------------------------------------------------------------------------------------------

export type GameDll = { name: string; path: string; version: string | null; kind: "xess" | "ffx"; link: boolean };
export type GameLastRun = {
  trace: boolean; fallback: string | null; compile_failed: boolean; canary: boolean;
  xell_unsupported: boolean | null; logged_at: number | null;
  xell_builtin?: boolean | null;           // XeLL's log: "Using built-in context" (cross-vendor mode); null: no log
  fg_fullscreen?: boolean | null;          // XeSS-FG's log: exclusive fullscreen refused interpolation
  xefg?: GameXefg | null;                  // XeSS-FG's log: frame generation refused (games.py xefg_check); null: no log
};
/** The tail of C:\igdext_xefg.log (written with XESS_LOG=1 or IGDEXT_XEFG_LOG=1). */
export type GameXefg = {
  logged_at: number; refused: boolean;
  reason: "latency_reduction_off" | "refused" | null;   // latency_reduction_off: "Latency reduction is not enabled" + -15
  code: number | null; call: string | null; lines: string[];
};
/** A known issue of one game (games.py KNOWN_ISSUES), with its source. */
export type GameIssue = { id: string; fg_crash: boolean; fsr_risk: boolean; label: string; line: string; detail: string; source: string };
/** A row of what the prefix or the last run shows (games.py _checks). */
export type GameCheck = {
  id: string; label: string; line: string; detail: string;
  at?: number | null;                      // when the log it comes from was written (Unix seconds)
  lines?: string[];                        // what that log says
};
export type GamePrefixChecks = { driverstore_capital: boolean; driverstore_capital_shimmed: boolean | null; hides_wine: boolean | null };
export type GameInfo = {
  appid: string; install_dir: string | null; prefix: string | null;
  compat_tool: string | null;              // the game's own choice in Steam; null: Steam's default
  default_compat_tool: string | null;
  compat_tool_dir: string | null; compat_tool_system: boolean;
  compat_tool_hook: boolean | null;        // install.sh's user_settings.py (XESS=latest, XESS_LOG, FSR need it)
  compat_tool_shimmed: boolean | null;     // its igdext64.dll is the shim (XeSS on XMX needs it)
  dlls: GameDll[];
  last_run: GameLastRun | null;
  advice: string[];
  /** What the automatic launch options may add (DESIGN.md "Automatic launch options"); older backends: absent. */
  suggest?: GameSuggest[];
  // 0.4.x (older backends: absent)
  known_issues?: GameIssue[];
  fg_crash?: boolean;                      // a known issue: XeSS frame generation crashes this game
  has_fg?: boolean | null;                 // libxess_fg.dll in the game's folder (null: folder unknown or searched in part)
  prefix_checks?: GamePrefixChecks | null;
  checks?: GameCheck[];
  // 0.5 (DESIGN.md "OptiScaler"; older backends: absent)
  opti_installed?: boolean;                // optiscaler.json says OptiScaler is in this game
  opti_entry?: boolean;                    // the game's row shows OptiScaler (0.5.1: every Steam game; 0.5: the table's)
};
export type GameSuggest = { key: ManagedKey; value: string; why: string };
export type GameInfoRes = Res & { game: GameInfo | null };

// ---- OptiScaler (DESIGN.md "OptiScaler (0.5)") ---------------------------------------------------------------------

export type OptiUpscaler = "xess" | "fsr31";
export type OptiFgInput = "dlssg" | "fsrfg" | "xefg" | "upscaler";
/** tested: OXP3 Deck's own setup (The Witcher 3); known: OptiScaler's wiki documents the game; generic: experimental. */
export type OptiKind = "tested" | "known" | "generic";
export type OptiApi = "dx12" | "dx11" | "vulkan";
export type OptiFg = 0 | 2 | 3 | 4;
export type OptiChoices = { upscaler: OptiUpscaler; fg: OptiFg; fg_input: OptiFgInput };
/** What the launch options get while OptiScaler is in the game (optiscaler.launch_plan); the frontend applies it. */
export type LaunchPlan = {
  set: Partial<Record<ManagedKey, string>>; remove: ManagedKey[];
  dll_override: string | null;             // "dxgi": WINEDLLOVERRIDES gains "dxgi=n,b"
  dxvk_config: string | null;              // "dxgi.customVendorId = 8086" (3x/4x only)
  args: string[];                          // ["-dx12"]
};
export type OptiInfo = {
  appid: string; supported: boolean;                    // in the table
  why: string | null;                                   // check()'s refusal, null when install would start
  state: "none" | "installed" | "partial" | "other";    // other: another tool's OptiScaler
  build: string | null; build_wanted: string | null; update: boolean;
  folder: string | null;                                // exe folder, shown in Details only
  choices: OptiChoices | null; defaults: OptiChoices | null; fg_inputs: OptiFgInput[];
  launch: LaunchPlan | null;                            // what the record says should be in the launch options
  cached: boolean; download_mb: number | null;          // the package is in the cache / the size to fetch
  unpacker: string | null;                              // "7z" / "bsdtar" / null
  notes: string[]; kept: string[]; overlay: boolean;
  launch_new?: LaunchPlan | null;                      // the plan an install with the defaults would write
  warnings?: string[];                                  // not refusals, only rows ("OptiScaler's XeSS will run in …")
  version?: string | null;                              // OptiScaler's version of the pinned build
  backed_up?: string[];                                 // files the install moved into the backup folder
  sources?: string[];                                   // the table entry's sources
  // 0.5.1 (DESIGN.md "OptiScaler for any game"; older backends: absent, read as the tested setup)
  kind?: OptiKind;
  name?: string | null;                                 // the game's name (its appmanifest's)
  api?: OptiApi | null;                                 // the API the setup is for
  api_why?: string | null;                              // generic: what showed it ("the exe loads d3d12.dll")
  exe?: string | null;                                  // the exe OptiScaler goes next to
  proxy?: string | null;                                // the file name OptiScaler takes ("dxgi" for dxgi.dll)
  pick?: string | null;                                 // known: what to pick in the game ("XeSS or DLSS")
  fg_ok?: boolean;                                      // frame generation possible (DirectX 12 only)
  upscaler_found?: boolean | null;                      // a DLSS, FSR 2+ or XeSS library was seen in the game
  fit?: "good" | "poor" | null;                         // known: the wiki's setup fits this device less well
  optifg_ini?: Record<string, string>;                  // the game's own OptiFG keys ({"OptiFG_HUDLimit": "1"})
  choices_stale?: boolean;                              // installed, but its saved choices are no longer offered
};
export type OptiInfoRes = Res & { opti: OptiInfo | null };
export type OptiJobResult = Res & {
  appid: string; build: string | null; folder: string | null;
  copied: number; backed_up: string[]; removed: number; kept: string[];   // kept: files left, with why
  launch: LaunchPlan | null;               // install/update: apply it; remove: undo it
  next: string | null;
};

// ---- jobs and misc -------------------------------------------------------------------------------------------------

export type JobRes = Res & { job: Job | null };
export type JobListRes = Res & { jobs: Job[] };

// ---- power (DESIGN.md "Power (TDP, GPU, CPU)") ---------------------------------------------------------------------

export type Epp = "performance" | "balance_performance" | "balance_power" | "power";
export type FanMode = "auto" | "quiet" | "max";
export type ScxMode = "auto" | "gaming" | "powersave";
export type GpuPowerProfile = "base" | "power_saving";
export type CoreType = "p" | "e" | "lpe";
export type PowerValues = {
  pl1_w: number | null; pl2_w: number | null; gpu_min_mhz: number | null; gpu_max_mhz: number | null;
  epp: Epp | null; turbo: boolean | null;              // null: the firmware's value
  // 0.4 (DESIGN.md "Power 0.4")
  cpu_max_pct: number | null; cpu_min_pct: number | null; soc_balance: number | null; soc_offset: number | null;
  gpu_power_profile: GpuPowerProfile | null;
  cpu_cap_p_mhz: number | null; cpu_cap_e_mhz: number | null; cpu_cap_lpe_mhz: number | null;
  epp_p: Epp | null; epp_e: Epp | null; epp_lpe: Epp | null;
  fan_mode: FanMode | null; scx_mode: ScxMode | null;  // applied by extras.py, also while TDP control is off
};
export type PowerProfile = { name: string | null; main: PowerValues; ac: PowerValues | null };
export type PowerOptions = { per_game: boolean; split_ac: boolean; extended: boolean; ignore: string[];
                             poll_s: number };    // 0 = Off, 2..60
export type PowerRange = {
  pl1_min: number; pl1_max: number; pl2_max: number;    // for the AC state now (W)
  pl1_max_battery: number; pl1_max_ac: number; extended_max: number | null;   // extended_max: OXP3 only
  gpu_min: number | null; gpu_max: number | null; gpu_efficient: number | null;   // rpn, rp0, rpe (MHz)
  spec: "oxp3" | "firmware";
  cpu_pct_min?: number; cpu_min_pct_fw?: number | null; cpu_min_pct_max?: number;     // 0.4: 30, firmware floor, 50
  core_types?: Partial<Record<CoreType, { min_mhz: number; max_mhz: number; policies: number }>>;
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
  fix_units: string[];                     // what Fix for me would stop and disable (and mask); [] = not offered
  fix_plan?: { disable: string[]; stop: string[]; mask?: string[] } | null;   // what it would run now; null = cannot tell
  fixed: PowerFixed | null;                // OXP3 Deck turned it off earlier (came_back: it runs again)
};
// was_masked: only on a unit Fix for me masked (always false: it was not masked before), so Undo unmasks it first
export type PowerFixedUnit = { unit: string; was_enabled: string; was_active: boolean; was_masked?: boolean };
export type PowerFixed = { id: string; name: string; at: number; units: PowerFixedUnit[]; came_back: boolean };
export type PowerFixStep = { unit: string; action: "stop" | "disable" | "mask" | "unmask" | "enable" | "start"; ok: boolean;
                             error: string | null };
export type PowerOverridden = { what: string; ours: string; now: string; since: number; suspects: string[] };
export type PowerApply = {
  ok: boolean; error: string | null; written: string[];
  failed: { id: string; error: string; locked: boolean; transient?: boolean }[];   // transient: retried (GPU busy: reset, resume, GuC error)
};
export type BlockedGroup = "epp" | "turbo" | "cpu_pct" | "cpu_caps" | "soc";
export type PowerGpuNow = { min: number | null; max: number | null; act: number | null; reasons: string[] };
export type PowerState = {
  enabled: boolean;
  active: { key: string; name: string; slot: "main" | "ac"; app: string | null; ac: boolean | null };
  values: PowerValues;                    // the active slot as stored
  applied_values: PowerValues;            // after clamping and with firmware values filled in (what was written)
  now: { pl1_w: number | null; pl2_w: number | null;     // effective: the lowest over the zones
         zones: PowerZone[];
         gpu: PowerGpuNow | null;
         epp: Epp | "default" | "mixed" | null; turbo: boolean | null; governor: string | null;
         // 0.4
         cpu_max_pct?: number | null; cpu_min_pct?: number | null;
         caps_mhz?: Partial<Record<CoreType, number | null>>;      // first policy of each type
         soc?: { balance: number; offset: number; profile: string | null; choices: string[] } | null;
         gpu_profile?: GpuPowerProfile | null;
         epp_types?: Partial<Record<CoreType, Epp | "default" | null>> };
  range: PowerRange;
  blocked_fields?: Partial<Record<BlockedGroup, string[]>>;    // 0.4: conflict ids per field group
  overridden: PowerOverridden | null;
  blocked: string | null;                 // why nothing is written although enabled
  cpu_blocked: string | null;             // "<name> controls energy preference and CPU boost"
  cpu_blocked_by: string[];               // the conflict ids behind cpu_blocked (their Fix for me goes under EPP)
  yielded?: BlockedGroup[];               // 0.4.x: field groups left to an ignored CPU program that changed them (until the next change)
  last: PowerApply | null;                // the last apply
};
export type PowerInfo = {
  hw: { rapl: boolean; mmio: boolean;
        gpu: { card: string; gt: string; media_gt: string | null; power_profile?: boolean } | null;
        cpu: { pstate: string | null; epp_choices: Epp[]; turbo: boolean; perf_pct?: boolean; types?: CoreType[] } | null;
        soc?: boolean;
        ac_supply: string | null; problems: string[] };
  options: PowerOptions;
  profiles: Record<string, PowerProfile>;  // "default" always present
  conflicts: PowerConflict[];
  fixed: PowerFixed[];                     // every record, also of conflicts that are gone (their Undo)
  boot: { taken_at: number } | null;
  sdtdp_found: boolean;                    // SimpleDeckyTDP's settings.json exists
  state: PowerState;
};
/** line e.g. "15 W / 25 W · Cyberpunk 2077" or "Off". */
export type PowerSummary = { enabled: boolean; line: string | null; overridden: boolean; blocked: string | null };
export type PowerInfoRes = Res & { info: PowerInfo | null };
export type PowerStateRes = Res & { state: PowerState | null };
export type PowerChangeRes = Res & { state: PowerState | null; applied: PowerApply | null;
                                     conflicts?: PowerConflict[] };   // conflicts: a refused enable
export type PowerImportRes = Res & { imported: string[]; skipped: string[]; state: PowerState | null };
export type PowerFixRes = Res & { steps: PowerFixStep[]; notes: string[]; state: PowerState | null;
                                  conflicts: PowerConflict[]; fixed: PowerFixed[]; applied: PowerApply | null };

// ---- live readouts and extras (DESIGN.md "Live readouts", "Extras") -------------------------------------------------

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
export type ChargeBehaviour = "auto" | "inhibit-charge-awake";
export type ExtrasOptions = { charge_limit: number | null; charge_behaviour: ChargeBehaviour | null; lpmd_game_off: boolean };
export type ExtrasWhat = "fan" | "scx" | "charge_limit" | "charge_behaviour";
export type ExtrasState = {
  board_ok: boolean; kernel: string;
  charge: { available: boolean; why: string | null; limit: number | null; behaviour: string | null;
            behaviours: ChargeBehaviour[];
            overridden: { limit: string | null; behaviour: string | null }; error?: string | null };
  fan: { available: boolean; why: string | null; rpm: number | null; mode_now: FanMode | "manual" | null;
         ours: FanMode | null; reverted: string | null; overridden: string | null; sleep_watch: boolean };
  scx: { shown: boolean; available: boolean; why: string | null; scheduler: string | null;
         mode: "auto" | "gaming" | "powersave" | "lowlatency" | "server" | null; ours: ScxMode | null;
         overridden: string | null; note?: string | null };
  lpmd: { shown: boolean; paused: boolean; state: string | null; error: string | null };
  options: ExtrasOptions;
};
export type ExtrasInfoRes = Res & { extras: ExtrasState | null };

// ---- automatic setup (DESIGN.md "Automatic setup (0.6)") -----------------------------------------------------------

/** What an automatic launch-option change did (autolaunch.applyAuto): keys added, keys taken out (their old values), arguments added. */
export type AutoApplied = { set: Partial<Record<ManagedKey, string>>; dropped: Partial<Record<ManagedKey, string>>; args: string[] };
export type AutoMode = "auto" | "manual";
export type AutoKind = "opti" | "launch" | "proton";
export type AutoChangeState = "live" | "undone" | "rolled_back" | "superseded";
export type AutoChange = {
  id: string;                         // "<kind>-<at>" (backend-made)
  kind: AutoKind; at: number;         // Unix seconds, backend time
  state: AutoChangeState; tested: boolean; kept: boolean; accepted: boolean;   // accepted: an offer the user tapped
  label: string;                      // ≤ 40: "OptiScaler" / "XESS=latest -dx12" / "GE-Proton11-11"
  why: string; short: string;         // why ≤ 200, short ≤ 40 ("for frame generation", "for XeSS")
  launch?: AutoApplied;               // kind launch
  proton?: { from: string; from_priority: number; to: string; to_display: string };
  opti?: { build: string; choices: OptiChoices };
  ended_at?: number | null;           // undone / rolled back / superseded at
};
export type AutoClass = "known" | "unknown" | "skipped";
export type AutoGame = {
  appid: string; name: string; class: AutoClass; skip_why: string | null;
  mode: AutoMode; mode_why: string | null; mode_by: "default" | "user" | "detected";
  seen_at: number; plan_version: number; changes: AutoChange[];
  session: { started_at: number | null; quick_exits: number; last_run_s: number | null };
  rollback_due: string | null;        // a change id
  notice: string | null; last_error: string | null;
};
export type AutoOffer = { id: "opti" | "fsr" | "proton"; label: string; line: string; why: string };
export type AutoProtonNote = { kind: "restart" | "unhooked" | "none" | "user_pick"; line: string; detail: string };
export type AutoPlan = {
  appid: string; name: string; on: boolean; class: AutoClass; skip_why: string | null;
  mode: AutoMode; mode_why: string | null;
  opti: { choices: OptiChoices; why: string; short: string } | null;
  launch: { plan: LaunchPlan; why: string; short: string } | null;    // set/remove/args; dll_override, dxvk_config null
  proton: { to: string; to_display: string; why: string } | null;
  proton_note: AutoProtonNote | null;
  offers: AutoOffer[]; rollback: AutoChange | null; needs_xess: boolean;
  game: AutoGame;
};
export type AutoCompat = { name: string; display: string; priority: number };
export type AutoTool = { name: string; display: string };
export type AutoFacts = { compat: AutoCompat | null; tools: AutoTool[]; hand: string[]; running: boolean };
/** What the frontend reports with auto_record (the backend sets id, at, state, tested). */
export type AutoChangeIn = {
  kind: "launch" | "proton"; label: string; why: string; short: string; accepted?: boolean;
  launch?: AutoApplied; proton?: { from: string; from_priority: number; to: string; to_display: string };
};
export type AutoStateRes = Res & { on: boolean; confirmed_at: number | null; games: Record<string, AutoGame> };
export type AutoPlanRes = Res & { plan: AutoPlan | null };
export type AutoGameRes = Res & { game: AutoGame | null };
export type AutoUndoRes = Res & { game: AutoGame | null; job: Job | null };
export type AutoSessionRes = Res & { rollback: AutoChange | null; game: AutoGame | null };
export type AutoPendingRes = Res & { appids: string[] };
