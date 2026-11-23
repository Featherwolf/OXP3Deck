// Power control's frontend logic, framework-free so node can test it (tests/js/power.test.mjs): the serial writer
// behind the sliders and the texts the Power section shows (DESIGN.md "Power (TDP, GPU, CPU)", Frontend).
import type {
  AdviceKind, CoreType, Epp, MeasureResult, PowerAdvice, PowerApply, PowerChangeRes, PowerConflict, PowerInfo, PowerLow,
  PowerOptions, PowerOverridden, PowerRange, PowerState, PowerValues, PowerZone, SelftestProbe, SelftestResult, Slot,
  TimeWindows,
} from "./types";

export type { Slot };
export type Send = (key: string, slot: Slot, values: Partial<PowerValues>) => Promise<PowerChangeRes>;
export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

type Change = { key: string; slot: Slot; values: Partial<PowerValues>; since: number; ready: boolean };

export type WriterOpts = {
  delay?: number;                         // ms after the last write() of a change (250)
  timers?: Timers;                        // tests pass fake ones
  now?: () => number;                     // ms; tests pass a fake clock
  /** The answer's state, only when no newer change waits or is in flight (a late answer cannot snap a slider back). */
  onState?: (state: PowerState, answer: PowerChangeRes) => void;
  /** Every answer, with stale = true when a newer change was made since it was sent. */
  onAnswer?: (answer: PowerChangeRes, stale: boolean) => void;
};

export type Writer = {
  write(key: string, slot: Slot, values: Partial<PowerValues>): void;
  flush(): void;
  /** flush(), then resolve once nothing waits or is in flight (await it before a call that depends on the edits). */
  drain(): Promise<void>;
  busy(): boolean;                        // a change waits or is in flight
  version(): number;                      // goes up with every write(): a poll started before a write is stale
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * One change at a time, in order. write() merges into the pending change of the same profile and slot and sends it
 * `delay` ms after the last call (and at the latest 2 × delay after the first, so a long slider drag applies about
 * every half second); while a send is in flight, newer changes wait and go, merged, once it answers.
 */
export const makeWriter = (send: Send, opts: WriterOpts = {}): Writer => {
  const delay = opts.delay ?? 250;
  const timers = opts.timers ?? realTimers;
  const now = opts.now ?? (() => Date.now());
  const queue: Change[] = [];
  let timer: unknown = null;
  let inflight = false;
  let writes = 0;
  let idle: (() => void)[] = [];

  const settle = () => {
    if (inflight || queue.length) return;
    const waiting = idle;
    idle = [];
    for (const r of waiting) r();
  };

  const stopTimer = () => { if (timer !== null) { timers.clear(timer); timer = null; } };

  const pump = () => {
    if (idle.length) for (const c of queue) c.ready = true;   // draining: newer changes go without their delay too
    if (inflight || !queue.length || !queue[0].ready) return;
    const c = queue.shift()!;
    inflight = true;
    const sentAt = writes;
    const done = (r: PowerChangeRes) => {
      inflight = false;
      const stale = writes !== sentAt || queue.length > 0;
      try { opts.onAnswer?.(r, stale); } catch { /* a dead subscriber */ }
      if (!stale && r.state) { try { opts.onState?.(r.state, r); } catch { /* a dead subscriber */ } }
      pump();
      settle();
    };
    let p: Promise<PowerChangeRes>;
    try { p = send(c.key, c.slot, c.values); } catch (e) { p = Promise.reject(e); }
    p.then(done, (e) => done({ ok: false, error: e instanceof Error ? e.message : String(e), state: null, applied: null }));
  };

  // every change but the last one is complete: only the last one may still be being dragged (a queued change is never
  // the one in flight, so merging into it is safe)
  const arm = () => {
    stopTimer();
    const last = queue[queue.length - 1];
    if (!last) return;
    for (const c of queue) if (c !== last) c.ready = true;
    const wait = Math.max(0, Math.min(delay, last.since + 2 * delay - now()));
    timer = timers.set(() => { timer = null; last.ready = true; pump(); }, wait);
    pump();
  };

  return {
    write(key, slot, values) {
      writes++;
      const last = queue[queue.length - 1];
      if (last && last.key === key && last.slot === slot) last.values = { ...last.values, ...values };
      else queue.push({ key, slot, values: { ...values }, since: now(), ready: false });
      arm();
    },
    flush() {
      stopTimer();
      for (const c of queue) c.ready = true;
      pump();
    },
    drain() {
      return new Promise<void>((resolve) => {
        idle.push(resolve);
        stopTimer();
        for (const c of queue) c.ready = true;
        pump();
        settle();
      });
    },
    busy: () => inflight || queue.length > 0,
    version: () => writes,
  };
};

// ---- what the sliders edit and show --------------------------------------------------------------------------------

/**
 * The slot the sliders edit: the active one (AC values only when they are split and in use; the low-battery values
 * while they run).
 */
export const editSlot = (state: PowerState, options: PowerOptions | null | undefined): Slot =>
  state.active.slot === "low" ? "low" : options?.split_ac && state.active.slot === "ac" ? "ac" : "main";

/** Every profile field, in power.py's FIELDS order (0.4: 19; T1-1 adds pl2_follow). */
export const FIELDS = ["pl1_w", "pl2_w", "gpu_min_mhz", "gpu_max_mhz", "epp", "turbo",
  "cpu_max_pct", "cpu_min_pct", "soc_balance", "soc_offset", "gpu_power_profile",
  "cpu_cap_p_mhz", "cpu_cap_e_mhz", "cpu_cap_lpe_mhz", "epp_p", "epp_e", "epp_lpe", "fan_mode", "scx_mode",
  "pl2_follow"] as const;
export const EMPTY: PowerValues = {
  pl1_w: null, pl2_w: null, gpu_min_mhz: null, gpu_max_mhz: null, epp: null, turbo: null,
  cpu_max_pct: null, cpu_min_pct: null, soc_balance: null, soc_offset: null, gpu_power_profile: null,
  cpu_cap_p_mhz: null, cpu_cap_e_mhz: null, cpu_cap_lpe_mhz: null, epp_p: null, epp_e: null, epp_lpe: null,
  fan_mode: null, scx_mode: null, pl2_follow: null,
};

/** "Reset to device defaults": every field power control writes back to null; fan and scheduler mode stay. */
export const RESET: Partial<PowerValues> = Object.fromEntries(
  FIELDS.filter((f) => f !== "fan_mode" && f !== "scx_mode").map((f) => [f, null])) as Partial<PowerValues>;

export const CORE_TYPES = ["p", "e", "lpe"] as const;
export const CAP_FIELD: Record<CoreType, "cpu_cap_p_mhz" | "cpu_cap_e_mhz" | "cpu_cap_lpe_mhz"> =
  { p: "cpu_cap_p_mhz", e: "cpu_cap_e_mhz", lpe: "cpu_cap_lpe_mhz" };
export const EPP_FIELD: Record<CoreType, "epp_p" | "epp_e" | "epp_lpe"> = { p: "epp_p", e: "epp_e", lpe: "epp_lpe" };
export const CORE_NAME: Record<CoreType, string> = { p: "Performance cores", e: "Efficient cores", lpe: "Low-power cores" };
export const CORE_SHORT: Record<CoreType, string> = { p: "performance cores", e: "efficient cores", lpe: "low-power cores" };

/** True when the values use a per-core cap (then the CPU speed cap is off: one or the other). */
export const usesCaps = (v: Partial<PowerValues> | null | undefined): boolean =>
  !!v && CORE_TYPES.some((t) => v[CAP_FIELD[t]] != null);

/** The one change that switches to the per-core caps (`caps`: MHz per type) or back to the speed cap (`pct`). */
export const toCaps = (caps: Partial<Record<CoreType, number>>): Partial<PowerValues> => {
  const out: Partial<PowerValues> = { cpu_max_pct: null };
  for (const t of CORE_TYPES) out[CAP_FIELD[t]] = caps[t] ?? null;
  return out;
};
export const toPct = (pct: number | null): Partial<PowerValues> =>
  ({ cpu_max_pct: pct, cpu_cap_p_mhz: null, cpu_cap_e_mhz: null, cpu_cap_lpe_mhz: null });

/** The CPU minimum speed's slider range: the device's own floor up to 50 %, never above the speed cap. */
export const minPctRange = (range: Pick<PowerRange, "cpu_min_pct_fw" | "cpu_min_pct_max">, cap: number | null | undefined): { lo: number; hi: number } => {
  const lo = Math.max(1, Math.round(range.cpu_min_pct_fw ?? 1));
  const hi = Math.max(lo, Math.min(range.cpu_min_pct_max ?? 50, Math.round(cap ?? 100)));
  return { lo, hi };
};

// ---- the polling rate (DESIGN.md "Polling rate") -------------------------------------------------------------------

/** The steps of "How often to check" (s); 0 = Off. */
export const POLL_STEPS = [0, 2, 3, 5, 10, 15, 20, 30, 45, 60] as const;
export const POLL_DEFAULT = 2;
/** The slider index of a poll_s value (the nearest step; an unknown value: the default's). */
export const pollIndex = (s: number | null | undefined): number => {
  const v = typeof s === "number" && Number.isFinite(s) ? s : POLL_DEFAULT;
  let best = 0;
  for (let i = 1; i < POLL_STEPS.length; i++) if (Math.abs(POLL_STEPS[i] - v) < Math.abs(POLL_STEPS[best] - v)) best = i;
  return best;
};
export const pollValue = (index: number): number => POLL_STEPS[Math.min(POLL_STEPS.length - 1, Math.max(0, Math.round(index)))];
export const pollText = (s: number): string => (s === 0 ? "Off" : `${s} s`);

/** What a control shows: the stored value, or (null: "firmware") the value applied for it. */
export const shown = (values: PowerValues | null | undefined, applied: PowerValues | null | undefined): PowerValues => {
  const out = { ...EMPTY } as Record<string, unknown>;
  for (const f of FIELDS) out[f] = values?.[f] ?? applied?.[f] ?? null;
  return out as PowerValues;
};

/** The values the system booted with, as far as the state shows them (the lowest over the RAPL zones). */
export const fwValues = (state: PowerState): PowerValues => {
  const low = (xs: (number | null)[]) => {
    const ok = xs.filter((x): x is number => x != null);
    return ok.length ? Math.min(...ok) : null;
  };
  return {
    ...EMPTY,
    pl1_w: low(state.now.zones.map((z) => z.boot_pl1_w)) ?? state.now.pl1_w,
    pl2_w: low(state.now.zones.map((z) => z.boot_pl2_w)) ?? state.now.pl2_w,
    gpu_min_mhz: state.range.gpu_min, gpu_max_mhz: state.range.gpu_max,
  };
};

/** The lowest boost value: never below sustained, never below the range's floor. */
export const pl2Floor = (pl1: number | null | undefined, range?: Pick<PowerRange, "pl1_min">): number =>
  Math.max(pl1 ?? range?.pl1_min ?? 0, range?.pl1_min ?? 0);

/** v as a whole number of watts inside the sustained range. */
export const clampW = (v: number, range: Pick<PowerRange, "pl1_min" | "pl1_max">): number => {
  const lo = Math.ceil(range.pl1_min), hi = Math.max(lo, Math.floor(range.pl1_max));
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
};

/** The change a new sustained value makes: boost moves along when it would end up below it (a following boost
 * moves by itself, so it is left alone). */
export const pl1Change = (pl1: number, pl2Shown: number | null | undefined, follow = false): Partial<PowerValues> =>
  !follow && pl2Shown != null && pl1 > pl2Shown ? { pl1_w: pl1, pl2_w: pl1 } : { pl1_w: pl1 };

/** power.py PL2_FOLLOW: boost = sustained × 1.25 on battery (or AC unknown), × 1.5 on AC. */
export const PL2_FOLLOW = { battery: 1.25, ac: 1.5 } as const;

/** "Steadier fps after loads" is on and acts: sustained set, boost left to it (an explicit boost wins). */
export const follows = (v: Partial<PowerValues> | null | undefined): boolean =>
  v?.pl2_follow === true && v.pl1_w != null && v.pl2_w == null;

/** power.py follow_pl2: the boost a following slot gets, rounded half up, at most pl2Max, never below pl1. */
export const followPl2 = (pl1: number, pl2Max: number, ac: boolean | null | undefined): number =>
  Math.max(pl1, Math.min(pl2Max, Math.floor(pl1 * PL2_FOLLOW[ac === true ? "ac" : "battery"] + 0.5)));

/** "follows sustained (+25 %)" / "(+50 %)" on AC. */
export const followText = (ac: boolean | null | undefined): string =>
  `follows sustained (+${Math.round((PL2_FOLLOW[ac === true ? "ac" : "battery"] - 1) * 100)} %)`;

/** Whether a slot runs on AC: "ac" yes, "low" no (battery only), "main" as the charger is now. */
export const slotAc = (slot: Slot, ac: boolean | null | undefined): boolean | null =>
  slot === "ac" ? true : slot === "low" ? false : ac ?? null;

/** "efficient" at the GPU's rpe, on a 50 MHz notch scale (Steam's slider places labels by notch index). */
export const gpuNotches = (range: PowerRange, step = 50) => {
  const lo = range.gpu_min, hi = range.gpu_max, eff = range.gpu_efficient;
  if (lo == null || hi == null || hi <= lo) return { notchCount: undefined, notchLabels: undefined };
  const notchCount = Math.floor((hi - lo) / step) + 1;
  if (eff == null || eff < lo || eff > hi) return { notchCount: undefined, notchLabels: undefined };
  const notchIndex = Math.round((eff - lo) / step);
  return { notchCount, notchLabels: [{ notchIndex, label: "efficient", value: lo + notchIndex * step }] };
};

// ---- texts ---------------------------------------------------------------------------------------------------------

export const watts = (w: number | null | undefined): string =>
  w == null ? "?" : `${Math.round(w * 10) / 10} W`;

const POWER_REASONS = new Set(["pl1", "pl2", "pl4", "vr_tdc", "power"]);
const THERMAL_REASONS = new Set(["thermal", "prochot", "ratl", "vr_thermalert"]);

/** The GPU's throttle reasons in words ("power-limited", "thermal-limited", else the names). */
export const reasonText = (reasons: string[] | null | undefined): string | null => {
  const rs = reasons ?? [];
  if (!rs.length) return null;
  const words: string[] = [];
  if (rs.some((r) => POWER_REASONS.has(r))) words.push("power-limited");
  if (rs.some((r) => THERMAL_REASONS.has(r))) words.push("thermal-limited");
  const other = rs.filter((r) => !POWER_REASONS.has(r) && !THERMAL_REASONS.has(r));
  if (other.length) words.push(`limited by ${other.join(", ")}`);
  return words.join(", ");
};

/** "15 W / 25 W · GPU 1450 MHz, power-limited": what runs now (the lowest limit over both RAPL interfaces). */
export const effectiveLine = (state: PowerState): string => {
  const n = state.now;
  const parts = [n.pl1_w == null && n.pl2_w == null ? "Power limits unreadable" : `${watts(n.pl1_w)} / ${watts(n.pl2_w)}`];
  if (n.gpu?.act != null) {
    const why = reasonText(n.gpu.reasons);
    parts.push(`GPU ${n.gpu.act} MHz${why ? `, ${why}` : ""}`);
  }
  return parts.join(" · ");
};

/** "Cyberpunk 2077 · on AC" / "Default · on battery". */
export const profileLine = (state: PowerState): string => {
  const a = state.active;
  const name = a.key === "default" ? "Default" : a.name || `App ${a.key}`;
  const power = a.ac === true ? "on AC" : a.ac === false ? "on battery" : null;
  return power ? `${name} · ${power}${a.slot === "ac" ? " (AC values)" : ""}` : name;
};

const IFACE = { msr: "MSR", mmio: "MMIO" } as const;

/** A written id in words: "intel-rapl:0/pl1" → "MSR PL1", "gpu/max" → "GPU max clock". */
export const idText = (id: string): string => {
  const m = /^intel-rapl(-mmio)?:(\d+)\/(pl\d)$/.exec(id);
  if (m) return `${m[1] ? IFACE.mmio : IFACE.msr}${m[2] !== "0" ? ` ${m[2]}` : ""} ${m[3].toUpperCase()}`;
  const p = /^epp\/(policy\d+)$/.exec(id);
  if (p) return `Energy preference (EPP, ${p[1]})`;
  const c = /^cpu\/cap\/(policy\d+)$/.exec(id);
  if (c) return `Core speed cap (${c[1]})`;
  return ({ "gpu/min": "GPU min clock", "gpu/max": "GPU max clock", epp: "Energy preference (EPP)", turbo: "CPU boost",
    "cpu/max_pct": "CPU speed cap (max_perf_pct)", "cpu/min_pct": "CPU minimum speed (min_perf_pct)",
    "soc/balance": "CPU vs GPU balance (slider_balance)", "soc/offset": "Slider offset (slider_offset)",
    "soc/profile": "SoC power profile (balanced)", "gpu/profile": "GPU power saving (power_profile)" } as Record<string, string>)[id] ?? id;
};

/**
 * One red row per item that did not take. Locked limits come from the zones (the run state keeps them all boot; an
 * apply skips a locked id, so the last apply no longer lists it): "MSR PL1 is locked by firmware at 25 W: ...".
 */
export const failedLines = (last: PowerApply | null | undefined, zones?: PowerZone[] | null): string[] => {
  const out: string[] = [];
  const lockedIds = new Set<string>();
  for (const z of zones ?? []) {
    for (const k of z.locked) {
      const id = `${z.id}/${k}`;
      lockedIds.add(id);
      const at = k === "pl1" ? z.pl1_w : z.pl2_w;
      const w = at == null ? "" : ` at ${watts(at)}`;
      out.push(`${idText(id)} is locked by firmware${w}: the limit cannot go above${w ? w.slice(3) : " it"} (the CPU uses the lower of the two).`);
    }
  }
  for (const f of last?.failed ?? []) {
    if (lockedIds.has(f.id) || f.transient) continue;
    out.push(f.locked ? `${idText(f.id)} is locked by firmware: the limit cannot go above its value (the CPU uses the lower of the two).`
      : `${idText(f.id)}: ${f.error}`);
  }
  return out;
};

/** "15 W steady · 25 W boost": the up-front line of the live status (the lowest limit over both interfaces). */
export const limitsLine = (state: Pick<PowerState, "now">): string => {
  const n = state.now;
  return n.pl1_w == null && n.pl2_w == null ? "Power limits unreadable" : `${watts(n.pl1_w)} steady · ${watts(n.pl2_w)} boost`;
};

/** A written id in plain words, for a label up front: "intel-rapl:0/pl1" → "Sustained power". */
export const plainId = (id: string): string => {
  const m = /\/(pl\d)$/.exec(id);
  if (m) return ({ pl1: "Sustained power", pl2: "Boost power" } as Record<string, string>)[m[1]] ?? "Power limit";
  if (id.startsWith("epp")) return "Energy preference";
  if (id.startsWith("cpu/cap/")) return "Core speed cap";
  if (id.startsWith("soc/")) return "CPU vs GPU balance";
  return ({ "gpu/min": "GPU minimum speed", "gpu/max": "GPU maximum speed", turbo: "CPU boost", "cpu/max_pct": "CPU speed cap",
    "cpu/min_pct": "CPU minimum speed", "gpu/profile": "GPU power saving" } as Record<string, string>)[id] ?? id;
};

/**
 * The red rows of what did not take, one line each up front (`line` null: the first sentence of `detail`); `detail`
 * is failedLines' full text for its Details.
 */
export const capRows = (last: PowerApply | null | undefined, zones?: PowerZone[] | null): { label: string; line: string | null; detail: string }[] => {
  const full = failedLines(last, zones);
  const out: { label: string; line: string | null; detail: string }[] = [];
  let i = 0;
  const lockedIds = new Set<string>();
  for (const z of zones ?? []) {
    for (const k of z.locked) {
      lockedIds.add(`${z.id}/${k}`);
      const at = k === "pl1" ? z.pl1_w : z.pl2_w;
      out.push({ label: at == null ? "Limit capped" : `Limit capped at ${watts(at)}`,
        line: at == null ? "The device firmware won't allow a higher limit." : `The device firmware won't allow more than ${watts(at)}.`,
        detail: full[i++] });
    }
  }
  for (const f of last?.failed ?? []) {
    if (lockedIds.has(f.id) || f.transient) continue;
    out.push(f.locked ? { label: `${plainId(f.id)}: capped`, line: "The device firmware won't allow a higher limit.", detail: full[i++] }
      : { label: `${plainId(f.id)} didn't apply`, line: null, detail: full[i++] });
  }
  return out;
};

export const STEAM_SUSPECT = { name: "Steam", fix: "Steam's own Performance settings: in Quick Access → Performance, turn off \"TDP limit\" and \"Manual GPU clock\"." };
export const OTHER_SUSPECT = { name: "Another program", fix: "" };

/** The suspects of a drift, with each one's guidance (from the active conflicts, or Steam's own controls). */
export const suspects = (o: PowerOverridden, conflicts: PowerConflict[] | null | undefined): { name: string; fix: string }[] =>
  o.suspects.map((id) => {
    if (id === "steam") return STEAM_SUSPECT;
    if (id === "other") return OTHER_SUSPECT;
    const c = (conflicts ?? []).find((x) => x.id === id);
    return c ? { name: c.name, fix: c.fix } : { name: id, fix: "" };
  });

export const overriddenText = (o: PowerOverridden, conflicts: PowerConflict[] | null | undefined): string => {
  const names = suspects(o, conflicts).map((s) => s.name);
  return `Something else changed the power limits (now ${o.now}, OXP3 Deck set ${o.ours}).${names.length ? ` Likely: ${names.join(", ")}.` : ""}`;
};

export const EPP_LABELS: Record<Epp, string> = {
  performance: "Performance", balance_performance: "Balance performance", balance_power: "Balance power", power: "Power saving",
};

/** The EPP dropdown: Device default (the firmware's), then the choices this CPU offers, in EPP_CHOICES' order. */
export const eppOptions = (choices: Epp[] | null | undefined): { data: Epp | null; label: string }[] => [
  { data: null, label: "Device default" },
  ...(Object.keys(EPP_LABELS) as Epp[]).filter((e) => !choices || choices.includes(e)).map((e) => ({ data: e, label: EPP_LABELS[e] })),
];

export const eppText = (e: string | null | undefined): string =>
  e == null ? "?" : e === "mixed" ? "mixed" : e === "default" ? "device default" : EPP_LABELS[e as Epp] ?? e;

const onOffText = (b: boolean | null | undefined): string => (b == null ? "?" : b ? "on" : "off");

/** The CPU values in effect now, one line (Power tab's CPU row, the quick panel under the CPU controls). */
export const cpuNowLine = (n: PowerState["now"]): string =>
  `Cap ${n.cpu_max_pct ?? "?"} % · Min ${n.cpu_min_pct ?? "?"} % · Energy: ${eppText(n.epp)} · Boost: ${onOffText(n.turbo)}${
    n.soc ? ` · Balance ${n.soc.balance} (${n.soc.profile ?? "?"})` : ""}`;

/** The red row when the cpufreq governor is `performance` (SimpleDeckyTDP's governor slider can leave it so). */
export const GOVERNOR_PERFORMANCE = {
  label: "CPU speed policy is Performance",
  line: "Energy preference and minimum speed don't apply; the CPU runs at its cap.",
  detail: "CPU speed policy is Performance: energy preference and minimum speed don't apply; the CPU runs at its cap. A reboot or the desktop's power settings reset it.",
};

const GROUP_NAMES: Record<string, string> = {
  epp: "energy preference", turbo: "CPU boost", cpu_pct: "the CPU speed cap and minimum", cpu_caps: "the per-core caps",
  soc: "the CPU vs GPU balance",
};

/** "Energy preference left to Power Profiles": an ignored program changed a field it owns (state.yielded). */
export const yieldedText = (groups: readonly string[] | null | undefined, owner: string): string | null => {
  const names = (groups ?? []).map((g) => GROUP_NAMES[g] ?? g);
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list[0].toUpperCase()}${list.slice(1)} left to ${owner}.`;
};

/** The game profiles in the editor's order: Default, the running game, then the others by name. */
export const profileOrder = (profiles: Record<string, { name: string | null }>, running: string | null | undefined): { key: string; label: string }[] => {
  const label = (k: string) => (k === "default" ? "Default" : profiles[k]?.name || `App ${k}`);
  const games = Object.keys(profiles).filter((k) => k !== "default")
    .sort((a, b) => (a === running ? -1 : b === running ? 1 : label(a).localeCompare(label(b))));
  return [{ key: "default", label: "Default" }, ...games.map((k) => ({ key: k, label: `${label(k)}${k === running ? " (running)" : ""}` }))];
};

/** The conflicts that keep "TDP control" from turning on (not ignored). */
export const blockers = (conflicts: PowerConflict[] | null | undefined): PowerConflict[] =>
  (conflicts ?? []).filter((c) => c.kind === "blocks" && !c.ignored);

// ---- one-tap presets (DESIGN.md "Performance batch", C) ---------------------------------------------------------

export type PresetId = "battery" | "balanced" | "performance" | "max";
export const PRESET_IDS: PresetId[] = ["battery", "balanced", "performance", "max"];
export const PRESET_LABEL: Record<PresetId, string> = { battery: "Battery", balanced: "Balanced",
  performance: "Performance", max: "Max" };
/**
 * The fields a preset sets (every other field of the slot stays as it is: a GPU speed cap the user set is kept).
 * The per-core-type energy preferences are cleared with `epp`, since the backend prefers them over `epp`.
 */
export const PRESET_FIELDS = ["pl1_w", "pl2_w", "epp", "epp_p", "epp_e", "epp_lpe", "turbo", "gpu_power_profile"] as const;
export type PresetField = typeof PRESET_FIELDS[number];
/** What the device and the conflicts allow: a field they do not is left out of a preset (never a refusal or a fight). */
export type PresetCaps = { epp_choices: Epp[]; turbo: boolean; gpu_profile: boolean; cpu_blocked: boolean };
type PresetOpts = Pick<PowerOptions, "split_ac" | "extended">;
type PresetRange = Pick<PowerRange, "pl1_min" | "pl2_max" | "pl1_max_battery" | "pl1_max_ac" | "extended_max">;

/**
 * The provisional values (not yet measured on this device): OEM presets 5/17/35 W, MSR boot PL1 25 W (Performance
 * is a step above stock), Max = the slot's ceiling. null = the firmware's value; "max" W are filled in by presetValues.
 */
type PresetRow = Pick<PowerValues, "pl1_w" | "pl2_w" | "epp" | "turbo" | "gpu_power_profile">;
const PRESET_TABLE: Record<PresetId, PresetRow> = {
  battery: { pl1_w: 10, pl2_w: 15, epp: "balance_power", turbo: false, gpu_power_profile: "power_saving" },
  balanced: { pl1_w: 17, pl2_w: 25, epp: "balance_performance", turbo: null, gpu_power_profile: null },
  performance: { pl1_w: 28, pl2_w: null, epp: "balance_performance", turbo: null, gpu_power_profile: null },
  max: { pl1_w: null, pl2_w: null, epp: "performance", turbo: true, gpu_power_profile: "base" },
};

/** The Battery preset as the low-battery slot uses it (power.py BATTERY_PRESET; tests/fixtures/power/presets.json). */
export const BATTERY_PRESET: Partial<PowerValues> = {
  pl1_w: 10, pl2_w: 15, epp: "balance_power", turbo: false, gpu_power_profile: "power_saving",
};

/** The slot's sustained-power ceiling: AC (extended when on), battery for split battery values and the low slot. */
export const presetCeiling = (range: PresetRange, slot: Slot, opts: PresetOpts): number => {
  const acTop = opts.extended && range.extended_max != null ? range.extended_max : range.pl1_max_ac;
  if (slot === "low" || (slot === "main" && opts.split_ac)) return range.pl1_max_battery;
  return acTop;
};

const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, hi), Math.max(lo, Math.round(v)));

/** A preset's values for a slot: every W clamped to [pl1_min, ceiling], boost to [sustained, pl2_max]. */
export const presetValues = (id: PresetId, range: PresetRange, slot: Slot, opts: PresetOpts, caps: PresetCaps): Partial<PowerValues> => {
  const t = PRESET_TABLE[id];
  const top = presetCeiling(range, slot, opts);
  const lo = Math.ceil(range.pl1_min);
  const pl1 = clampTo(id === "max" ? top : t.pl1_w ?? top, lo, Math.floor(top));
  const pl2 = id === "max" ? clampTo(range.pl2_max, pl1, Math.floor(range.pl2_max))
    : t.pl2_w == null ? null : clampTo(t.pl2_w, pl1, Math.floor(range.pl2_max));
  const out: Partial<PowerValues> = { pl1_w: pl1, pl2_w: pl2 };
  if (!caps.cpu_blocked && t.epp != null && caps.epp_choices.includes(t.epp)) {
    out.epp = t.epp;
    out.epp_p = null; out.epp_e = null; out.epp_lpe = null;     // else the per-type values keep running
  }
  if (!caps.cpu_blocked && caps.turbo) out.turbo = t.turbo;
  if (caps.gpu_profile) out.gpu_power_profile = t.gpu_power_profile;
  return out;
};

/** What the device allows for presets, from the power info and state. */
export const presetCaps = (info: Pick<PowerInfo, "hw"> | null | undefined, state: Pick<PowerState, "cpu_blocked" | "blocked_fields"> | null | undefined): PresetCaps => ({
  epp_choices: info?.hw.cpu?.epp_choices ?? [],
  turbo: !!info?.hw.cpu?.turbo,
  gpu_profile: !!info?.hw.gpu?.power_profile,
  cpu_blocked: !!state?.cpu_blocked || !!state?.blocked_fields?.epp?.length || !!state?.blocked_fields?.turbo?.length,
});

/** The preset the stored slot matches (only the fields that preset sets, W after the same clamping), else custom/default. */
export const presetOf = (values: Partial<PowerValues> | null | undefined, range: PresetRange, slot: Slot, opts: PresetOpts,
  caps: PresetCaps): PresetId | "custom" | "default" => {
  const v = values ?? {};
  for (const id of PRESET_IDS) {
    const pv = presetValues(id, range, slot, opts, caps);
    const top = Math.floor(presetCeiling(range, slot, opts));
    const pl1 = v.pl1_w == null ? null : clampTo(v.pl1_w, Math.ceil(range.pl1_min), top);
    const norm: Partial<PowerValues> = {
      ...v, pl1_w: pl1,
      pl2_w: v.pl2_w == null ? null : clampTo(v.pl2_w, pl1 ?? Math.ceil(range.pl1_min), Math.floor(range.pl2_max)),
    };
    if ((Object.keys(pv) as PresetField[]).every((f) => (norm[f] ?? null) === (pv[f] ?? null))) return id;
  }
  return PRESET_FIELDS.every((f) => (v[f] ?? null) === null) ? "default" : "custom";
};

/** The PRESET_FIELDS values of a slot (Undo after a preset tap writes them back), plus pl2_follow when it is on
 * (presetWrite may turn it off). */
export const presetFieldsOf = (v: Partial<PowerValues> | null | undefined): Partial<PowerValues> => {
  const out = Object.fromEntries(PRESET_FIELDS.map((f) => [f, v?.[f] ?? null])) as Partial<PowerValues>;
  if (v?.pl2_follow === true) out.pl2_follow = true;
  return out;
};

/** A preset tap's write: a preset with its own boost turns "Steadier fps after loads" off (its boost would win and
 * the toggle would show on for nothing); one that leaves boost to the device (Performance) keeps it. */
export const presetWrite = (pv: Partial<PowerValues>, stored: Partial<PowerValues> | null | undefined): Partial<PowerValues> =>
  stored?.pl2_follow === true && pv.pl2_w != null ? { ...pv, pl2_follow: null } : pv;

export const NOT_MEASURED = "not yet measured on this device";

/** "Balanced: 17 W, boost 25 W · not yet measured on this device" / "Custom: set by hand" / "Device defaults". */
export const presetLine = (which: PresetId | "custom" | "default", v: Partial<PowerValues>, measured: boolean): string => {
  if (which === "custom") return "Custom: set by hand";
  if (which === "default") return "Device defaults";
  const head = `${PRESET_LABEL[which]}: ${watts(v.pl1_w)}, boost ${v.pl2_w != null ? watts(v.pl2_w) : follows(v) ? "follows sustained" : "device default"}`;
  return measured ? head : `${head} · ${NOT_MEASURED}`;
};

/** The Preset row's Details: what the preset sets, provisional or measured. */
export const presetDetails = (which: PresetId | "custom" | "default", v: Partial<PowerValues>, measures: MeasureResult[] | null | undefined): string[] => {
  const ms = measures ?? [];
  const out = [
    "Battery, Balanced, Performance and Max set sustained and boost power, energy preference (per core type too), CPU boost and GPU power saving in one tap. Every other setting stays, a GPU speed cap included. Moving any of those sliders by hand makes it Custom. A preset with its own boost (all but Performance) turns off Steadier fps after loads.",
  ];
  if (!ms.length) out.push("These are starting points from ONEXPLAYER's own presets and the device's firmware values, not yet measured on this device.");
  if (which !== "custom" && which !== "default") {
    const m = ms.find((x) => x.pl1_w != null && x.pl1_w === v.pl1_w && x.avg_package_w != null);
    if (m) out.push(`Measured: ${Math.round(m.seconds)} s at ${watts(m.pl1_w)}, ${w1(m.avg_package_w)} average${m.avg_gpu_busy_pct != null ? `, GPU ${Math.round(m.avg_gpu_busy_pct)} %` : ""}.`);
  }
  out.push("Battery 10 W / boost 15 W, Balanced 17 / 25 W, Performance 28 W with the device's own boost, Max the highest this power source allows.");
  return out;
};

// ---- low battery (DESIGN.md "Performance batch", D) ------------------------------------------------------------

export const LOW_PCT_DEFAULT = 20;
export const LOW_HYST_PCT = 5;
export const LOW_SLIDER = { min: 10, max: 40, step: 5 } as const;

/** The low-battery options with their defaults (an older backend: absent). */
export const lowOptions = (o: Partial<PowerOptions> | null | undefined) => ({
  on: o?.low_battery ?? true,
  pct: typeof o?.low_battery_pct === "number" ? o.low_battery_pct : LOW_PCT_DEFAULT,
  games: o?.low_battery_games ?? false,
});

/** The low slot's values as the sliders show them: stored, else the Battery preset's. */
export const lowStored = (low: PowerValues | null | undefined): PowerValues => low ?? { ...EMPTY, ...BATTERY_PRESET };

/** The status row while the low-battery slot runs or is held back: label and line (≤ 80), or null. */
export const lowLine = (low: PowerLow | null | undefined, game?: string | null): { label: string; line: string; muted: boolean } | null => {
  if (!low || (!low.active && !low.held)) return null;
  const pct = low.pct == null ? "Low battery" : `${low.pct} %`;
  if (low.active) return { label: "Low battery", line: `${pct}: saving power until ${low.leave_pct} % or plugged in.`, muted: false };
  return { label: "Low battery", line: fitText(`${pct}: ${game || "this game"} keeps its own profile.`), muted: true };
};

/** The low-battery toggle's one line: "Below 20 % on battery, use battery-saving values until 25 % or plugged in." */
export const lowToggleLine = (pct: number): string =>
  `Below ${pct} % on battery, use battery-saving values until ${pct + LOW_HYST_PCT} % or plugged in.`;

// ---- device check and measurement (DESIGN.md "Performance batch", B) -------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A Unix time as "23 Nov 14:02" (local time). */
export const dateText = (t: number): string => {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fitText = (s: string, max = 80) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const w1 = (w: number | null | undefined) => (w == null ? "?" : `${(Math.round(w * 10) / 10).toFixed(1)} W`);
const pctText = (x: number | null | undefined) => (x == null ? "?" : `${Math.round(x)} %`);

const OUTCOME_SHORT: Record<string, string> = {
  locked: "locked by firmware", ignored: "ignored by firmware", unsupported: "not supported", skipped: "skipped",
  not_restored: "not put back",
};

/** "11 of 12 work · 1 locked by firmware · 23 Nov 14:02"; red when a probe was not put back. */
export const selftestLine = (test: SelftestResult | null | undefined, fmt: (t: number) => string = dateText): { line: string; red: boolean } | null => {
  if (!test) return null;
  const ps = test.probes ?? [];
  const tried = ps.filter((p) => p.outcome !== "skipped");
  const ok = tried.filter((p) => p.outcome === "ok").length;
  const parts = [`${ok} of ${tried.length} work`];
  for (const k of ["not_restored", "locked", "ignored", "unsupported", "skipped"]) {
    const n = ps.filter((p) => p.outcome === k).length;
    if (n) parts.push(`${n} ${OUTCOME_SHORT[k]}`);
  }
  if (test.stopped) parts.push("stopped");
  parts.push(fmt(test.at));
  return { line: fitText(parts.join(" · ")), red: ps.some((p) => p.outcome === "not_restored") };
};

/** One probe in words: "Sustained power (MSR): locked by firmware", "GPU maximum speed: works (2300 → 2250 MHz)". */
export const probeLine = (p: SelftestProbe): string => {
  const what = p.label || p.id;
  switch (p.outcome) {
    case "ok": return `${what}: works${p.before != null && p.tried != null ? ` (${p.before} → ${p.tried})` : ""}`;
    case "locked": return `${what}: locked by firmware`;
    case "ignored": return `${what}: the device ignored the change${p.read != null ? ` (stayed ${p.read})` : ""}`;
    case "unsupported": return `${what}: not supported here`;
    case "skipped": return `${what}: not tried${p.why ? `: ${p.why}` : ""}`;
    case "not_restored": return `${what}: did not go back${p.read != null ? ` (reads ${p.read})` : ""}; power control set your value again`;
    default: return `${what}: ${p.outcome}`;
  }
};

/** A RAPL time window: ≥ 10 s "28 s", ≥ 1 s "2.5 s", ≥ 1 ms "2.4 ms", else "µs". */
export const tauText = (us: number | null | undefined): string => {
  if (us == null || !Number.isFinite(us)) return "?";
  if (us >= 10e6) return `${Math.round(us / 1e6)} s`;
  if (us >= 1e6) return `${(Math.round(us / 1e5) / 10).toFixed(1)} s`;
  if (us >= 1e3) return `${(Math.round(us / 100) / 10).toFixed(1)} ms`;
  return `${Math.round(us)} µs`;
};

const zoneName = (id: string) => {
  const m = /^intel-rapl(-mmio)?:(\d+)/.exec(id);
  return m ? `${m[1] ? "MMIO" : "MSR"}${m[2] !== "0" ? ` ${m[2]}` : ""}` : id;
};

/** "Sustained over 28 s, boost over 2.4 ms": the MSR package zone's windows (else the first zone's), or null. */
export const timeWindowsLine = (tw: TimeWindows | null | undefined): string | null => {
  const ids = Object.keys(tw ?? {}).sort((a, b) => (a.includes("mmio") === b.includes("mmio") ? a.localeCompare(b) : a.includes("mmio") ? 1 : -1));
  if (!tw || !ids.length) return null;
  const z = tw[ids[0]];
  if (z.pl1_us == null && z.pl2_us == null) return null;
  return `Sustained over ${tauText(z.pl1_us)}, boost over ${tauText(z.pl2_us)}`;
};

/** One line per zone, MSR before MMIO: "MSR: sustained 28 s, boost 2.4 ms". */
export const timeWindowsLines = (tw: TimeWindows | null | undefined): string[] =>
  Object.keys(tw ?? {}).sort((a, b) => (a.includes("mmio") === b.includes("mmio") ? a.localeCompare(b) : a.includes("mmio") ? 1 : -1))
    .map((id) => `${zoneName(id)} (${id}): sustained ${tauText(tw![id].pl1_us)}, boost ${tauText(tw![id].pl2_us)}`);

/** The share of samples a power limit held the GPU back (0..1), or null when no reason was seen. */
export const limitedShare = (reasons: Record<string, number> | null | undefined): number | null => {
  const xs = Object.entries(reasons ?? {}).filter(([k]) => POWER_REASONS.has(k)).map(([, v]) => v);
  return xs.length ? Math.max(...xs) : null;
};

/** "Idle on battery: 4.1 W average, 6.0 W peak, GPU 3 %" / "Cyberpunk 2077 at 25 W: 24.6 W average, GPU 98 %, power-limited 92 %". */
export const measureLine = (m: MeasureResult | null | undefined): string | null => {
  if (!m) return null;
  const src = m.ac === true ? " plugged in" : m.ac === false ? " on battery" : "";
  const lim = limitedShare(m.reasons);
  if (m.mode === "idle") {
    return fitText(`Idle${src}: ${w1(m.avg_package_w)} average, ${w1(m.max_package_w)} peak, GPU ${pctText(m.avg_gpu_busy_pct)}`);
  }
  const tail = `${m.pl1_w != null ? ` at ${watts(m.pl1_w)}` : ""}: ${w1(m.avg_package_w)} average, GPU ${pctText(m.avg_gpu_busy_pct)}${lim != null && lim > 0 ? `, power-limited ${Math.round(lim * 100)} %` : ""}`;
  const name = m.name || (m.appid ? `App ${m.appid}` : "Game");
  return `${fitText(name, Math.max(12, 80 - tail.length))}${tail}`;
};

/** Every field of a measurement, one line each (the Details). */
export const measureLines = (m: MeasureResult, fmt: (t: number) => string = dateText): string[] => [
  `${fmt(m.at)} · ${Math.round(m.seconds)} s · ${m.mode === "idle" ? "idle" : m.name || `app ${m.appid ?? "?"}`}`,
  `Power source: ${m.ac == null ? "unknown" : m.ac ? "plugged in" : "battery"} · profile ${m.profile} (${m.slot})`,
  `Limits at the start: sustained ${watts(m.pl1_w)}, boost ${watts(m.pl2_w)}`,
  `Package: ${w1(m.avg_package_w)} average, ${w1(m.max_package_w)} peak`,
  `GPU busy: ${pctText(m.avg_gpu_busy_pct)} on average`,
  `Battery: ${m.avg_battery_w == null ? "not discharging" : `${w1(m.avg_battery_w)} average`}`,
  `GPU throttle reasons: ${Object.keys(m.reasons ?? {}).length ? Object.entries(m.reasons).map(([k, v]) => `${k} ${Math.round(v * 100)} %`).join(", ") : "none"}`,
  `CPU thermal throttling: ${m.cpu_throttle_ms == null ? "?" : `${Math.round(m.cpu_throttle_ms)} ms`}`,
  ...(m.interrupted ? [`Stopped early: ${m.interrupted}`] : []),
];

// ---- power tips (DESIGN.md "Performance batch", E) -------------------------------------------------------------

/** The Power tip row's line (≤ 80). */
export const adviceLine = (a: PowerAdvice): string => {
  const now = watts(a.pl1_w);
  const by: Record<AdviceKind, string> = {
    headroom: `GPU has headroom: ${watts(a.suggest_w)} would likely keep your fps (now ${now})`,
    raise: `Power-limited at ${now}: ${watts(a.suggest_w)} may give more fps`,
    plug: `Power-limited at ${now}: plug in for up to ${watts(a.pl1_max_ac)}`,
    cpu: `Power-limited at ${now}: a lower CPU speed cap leaves the GPU more`,
  };
  return fitText(by[a.kind] ?? `Power tip at ${now}`);
};

/** "Use 15 W" is offered for these kinds only (the others suggest no value). */
/** Whose sustained power "Use N W" writes (PerfRows use(): the game's profile, a new one, or Default). */
export const adviceTarget = (name: string, own: boolean, perGame: boolean): string =>
  perGame ? (own ? name : `a new profile for ${name}`) : "the Default profile";

export const adviceUsable = (a: PowerAdvice | null | undefined): a is PowerAdvice & { suggest_w: number } =>
  !!a && (a.kind === "headroom" || a.kind === "raise") && typeof a.suggest_w === "number";

/** The Power tip's Details paragraphs. */
export const adviceDetails = (a: PowerAdvice): string[] => {
  const st = a.stats;
  const min = Math.max(1, Math.round(a.seconds / 60));
  const out = [`Over ${min} min at ${watts(a.pl1_w)}: ${w1(st.avg_package_w)} on average (90 % of the time under ${w1(st.p90_package_w)}), GPU busy ${pctText(st.avg_gpu_busy_pct)}, held back by the power limit ${Math.round(st.limited_share * 100)} % of the time.`];
  if (a.kind === "headroom") out.push("A lower limit usually keeps a frame-capped game at the same fps and saves battery. If fps drops, tap Undo or move the slider.");
  if (a.kind === "raise") out.push("The game uses all the power it gets and the GPU is busy nearly all the time: a higher limit may give more fps, and costs battery.");
  if (a.kind === "plug") out.push(`On battery the limit stops at ${watts(a.pl1_w)}; plugged in it can go up to ${watts(a.pl1_max_ac)}.`);
  if (a.kind === "cpu") out.push("The limit is at its top. A lower CPU speed cap (CPU group) leaves more of the power to the GPU.");
  if (st.thermal_share > 0.1) out.push(`It was also held back by heat ${Math.round(st.thermal_share * 100)} % of the time.`);
  out.push("Nothing changes until you tap the button.");
  return out;
};
