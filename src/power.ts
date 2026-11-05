// Power control's frontend logic, framework-free so node can test it (tests/js/power.test.mjs): the serial writer
// behind the sliders and the texts the Power section shows (DESIGN.md "Power (TDP, GPU, CPU)", Frontend).
import type {
  Epp, PowerApply, PowerChangeRes, PowerConflict, PowerOptions, PowerOverridden, PowerRange, PowerState, PowerValues,
  PowerZone,
} from "./types";

export type Slot = "main" | "ac";
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

/** The slot the sliders edit: the active one (AC values only when they are split and in use). */
export const editSlot = (state: PowerState, options: PowerOptions | null | undefined): Slot =>
  options?.split_ac && state.active.slot === "ac" ? "ac" : "main";

export const FIELDS = ["pl1_w", "pl2_w", "gpu_min_mhz", "gpu_max_mhz", "epp", "turbo"] as const;
export const EMPTY: PowerValues = { pl1_w: null, pl2_w: null, gpu_min_mhz: null, gpu_max_mhz: null, epp: null, turbo: null };

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

/** The change a new sustained value makes: boost moves along when it would end up below it. */
export const pl1Change = (pl1: number, pl2Shown: number | null | undefined): Partial<PowerValues> =>
  pl2Shown != null && pl1 > pl2Shown ? { pl1_w: pl1, pl2_w: pl1 } : { pl1_w: pl1 };

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
  return ({ "gpu/min": "GPU min clock", "gpu/max": "GPU max clock", epp: "Energy preference (EPP)", turbo: "CPU boost" } as Record<string, string>)[id] ?? id;
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
    if (lockedIds.has(f.id)) continue;
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
  return ({ "gpu/min": "GPU minimum speed", "gpu/max": "GPU maximum speed", turbo: "CPU boost" } as Record<string, string>)[id] ?? id;
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
    if (lockedIds.has(f.id)) continue;
    out.push(f.locked ? { label: `${plainId(f.id)}: capped`, line: "The device firmware won't allow a higher limit.", detail: full[i++] }
      : { label: `${plainId(f.id)} didn't apply`, line: null, detail: full[i++] });
  }
  return out;
};

export const STEAM_SUSPECT = { name: "Steam", fix: "Steam's own Performance settings: in Quick Access → Performance, turn off \"TDP limit\" and \"Manual GPU clock\"." };

/** The suspects of a drift, with each one's guidance (from the active conflicts, or Steam's own controls). */
export const suspects = (o: PowerOverridden, conflicts: PowerConflict[] | null | undefined): { name: string; fix: string }[] =>
  o.suspects.map((id) => {
    if (id === "steam") return STEAM_SUSPECT;
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
