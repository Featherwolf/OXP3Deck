// The quick panel's groups (DESIGN.md "Quick Access groups"): their ids, titles and defaults, the remembered open
// state, the one-line summaries of a closed group and its alert line. Pure, so node can test it
// (tests/js/quickgroups.test.mjs); Group.tsx and pages/Quick.tsx wire it to React.
import { fit } from "./autosetup";
import { friendlyName, lockedLine } from "./conflicts";
import { liveLine } from "./live";
import { blockers, capRows, editSlot, EMPTY, fwValues, GOVERNOR_PERFORMANCE, shown, type Slot, usesCaps, watts } from "./power";
import { firstSentence, MAX_LINE } from "./text";
import type { ExtrasState, Live, PowerConflict, PowerInfo, PowerState, PowerValues, ScxMode, XessSummary } from "./types";

export type GroupId = "live" | "game" | "power" | "cpu" | "battery" | "xess" | "fixes";

/** In panel order (Status above them has no header); `open`: the default before the user toggles it. */
export const GROUPS: readonly { id: GroupId; title: string; open: boolean }[] = [
  { id: "live", title: "Live", open: false },
  { id: "game", title: "This game", open: true },
  { id: "power", title: "Power", open: true },
  { id: "cpu", title: "CPU", open: false },
  { id: "battery", title: "Fan & battery", open: false },
  { id: "xess", title: "XeSS", open: false },
  { id: "fixes", title: "Device fixes", open: false },
];

/** The `remember` key (localStorage, per device) of the groups the user toggled. */
export const GROUPS_KEY = "quickGroups";

export type GroupState = Partial<Record<GroupId, boolean>>;

const IDS = new Set<string>(GROUPS.map((g) => g.id));

/** The stored JSON `{id: boolean}`; junk, unknown ids and non-boolean values are left out. */
export const parseGroups = (raw: string | null | undefined): GroupState => {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: GroupState = {};
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) if (IDS.has(k) && typeof b === "boolean") out[k as GroupId] = b;
  return out;
};

export const defaultOpen = (id: GroupId): boolean => GROUPS.find((g) => g.id === id)?.open ?? false;

/** Open: the user's choice, else the group's default. */
export const isOpen = (s: GroupState, id: GroupId): boolean => s[id] ?? defaultOpen(id);

/** The state after A on a group's header (only toggled groups are stored). */
export const toggled = (s: GroupState, id: GroupId): GroupState => ({ ...s, [id]: !isOpen(s, id) });

// ---- alerts ---------------------------------------------------------------------------------------------------------

/** A red line that a closed group still shows: its label and one line, for the header. */
export type Alert = { label: string; line: string | null };

/** The first alert that is there, else null. */
export const alertOf = (candidates: (Alert | null | undefined | false)[]): Alert | null =>
  candidates.find((a): a is Alert => !!a) ?? null;

/** The header's line: an alert wins over the summary (red); at most MAX_LINE characters. */
export const headerLine = (summary: string, alert: Alert | null | undefined): { text: string; red: boolean } =>
  alert ? { text: fit(alert.line ? `${alert.label}: ${alert.line}` : alert.label, MAX_LINE), red: true }
    : { text: fit(summary, MAX_LINE), red: false };

const listText = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const names = (cs: PowerConflict[]) => listText(cs.map((c) => friendlyName(c.id, c.name)));

/** The conflicts behind cpu_blocked (cpu_blocked_by; an older backend: every cpu conflict not handled). */
export const cpuBlockers = (state: PowerState, info: PowerInfo | null): PowerConflict[] => {
  if (!state.cpu_blocked) return [];
  const all = info?.conflicts ?? [];
  const by = state.cpu_blocked_by ?? [];
  return by.length ? all.filter((c) => by.includes(c.id)) : all.filter((c) => c.kind === "cpu" && !c.ignored);
};

/** Power's alert: paused, overridden, the performance governor, locked limits, unavailable, a refused enable, a read error. */
export const powerAlert = (info: PowerInfo | null, state: PowerState | null, error: string | null, refused: PowerConflict[] = []): Alert | null => {
  const caps = state?.enabled ? capRows(state.last, state.now.zones) : [];
  const problems = info?.hw.problems ?? [];
  return alertOf([
    !!state?.enabled && !!state.blocked && { label: "Power control paused", line: `${names(blockers(info?.conflicts)) || "Another program"} is also changing power limits.` },
    !!state?.enabled && !!state.overridden && { label: "Something changed your power limits", line: "Fix it, then tap Take control again." },
    !!state?.enabled && state.now.governor === "performance" && { label: GOVERNOR_PERFORMANCE.label, line: null },
    caps.length > 0 && { label: caps[0].label, line: caps[0].line ?? firstSentence(caps[0].detail) },
    problems.length > 0 && { label: "Power control unavailable", line: firstSentence(problems[0]) },
    refused.length > 0 && { label: `Turn off ${names(refused)} first`, line: null },
    !!error && { label: "Power: did not work", line: firstSentence(error) },
  ]);
};

/** CPU's alert: a program locks the CPU controls, something else changed the scheduler mode. */
export const cpuAlert = (info: PowerInfo | null, state: PowerState | null, x: ExtrasState | null): Alert | null => {
  const lockers = state?.enabled ? cpuBlockers(state, info) : [];
  return alertOf([
    lockers.length > 0 && { label: "CPU controls locked", line: lockedLine(lockers.map((c) => friendlyName(c.id, c.name))) },
    !!x?.scx.shown && !!x.scx.overridden && { label: "Something else changed the scheduler mode", line: "Likely CachyOS's power switch." },
  ]);
};

/** Fan & battery's alert: something else changed the fan, the charge limit or Run from charger; a battery error. */
export const batteryAlert = (x: ExtrasState | null): Alert | null => alertOf([
  !!x?.fan.available && !!x.fan.overridden && { label: "Something else changed the fan", line: "Turn its fan control off, then Take control." },
  !!x?.charge.available && !!x.charge.overridden.limit && { label: "Something else changed the charge limit", line: x.charge.overridden.limit },
  !!x?.charge.available && !!x.charge.overridden.behaviour && { label: "Something else changed Run from charger", line: x.charge.overridden.behaviour },
  !!x?.charge.available && !!x.charge.error && { label: "Battery: did not work", line: firstSentence(x.charge.error) },
]);

// ---- the values the sliders edit -------------------------------------------------------------------------------------

/** The profile slot the quick sliders edit, its stored values and the editor's "Edits …" name. */
export const editedSlot = (s: PowerState, info: PowerInfo | null): { slot: Slot; stored: PowerValues; label: string } => {
  const slot = editSlot(s, info?.options);
  const prof = info?.profiles?.[s.active.key];
  const stored = s.active.slot === slot ? s.values : (slot === "ac" ? prof?.ac ?? prof?.main : prof?.main) ?? s.values;
  const label = `${s.active.key === "default" ? "the default profile" : `the profile of ${s.active.name || `app ${s.active.key}`}`}${info?.options.split_ac ? (slot === "ac" ? " (plugged-in values)" : " (battery values)") : ""}`;
  return { slot, stored: stored ?? EMPTY, label };
};

/** What the open group's sliders show: the stored value, else what runs now, else the boot value. */
export const editedValues = (s: PowerState, stored: PowerValues): PowerValues => shown(stored, shown(s.applied_values, fwValues(s)));

// ---- summaries (the closed header's one line) --------------------------------------------------------------------

const join = (parts: (string | null | undefined | false)[]) => fit(parts.filter((p): p is string => !!p).join(" · "), MAX_LINE);

export const liveSummary = (live: Live | null | undefined, error: string | null | undefined): string =>
  error ? "Couldn't read." : liveLine(live);

/** "Cyberpunk 2077 · Automatic · Own power profile" / "Hades II · Manual". mode null: automatic setup is off. */
export const gameSummary = (name: string, mode: "auto" | "manual" | null, ownProfile: boolean): string => {
  const tail = [mode === "auto" ? "Automatic" : mode === "manual" ? "Manual" : null, ownProfile ? "Own power profile" : null].filter(Boolean).join(" · ");
  if (!tail) return fit(name || "This game", MAX_LINE);
  const room = MAX_LINE - tail.length - 3;
  return `${fit(name || "This game", Math.max(10, room))} · ${tail}`;
};

const profileName = (s: PowerState) => (s.active.key === "default" ? "Default" : s.active.name || `App ${s.active.key}`);
const mhz = (x: number | null) => (x == null ? "default" : `${x}`);

/**
 * "15 W · boost 25 W · GPU 300–2300 MHz · Default": the values the sliders edit; "Off · device defaults" while
 * power control is off. `yieldedTo`: an ignored program changed a CPU setting back ("Left to <x>").
 */
export const powerSummary = (s: PowerState | null, v: PowerValues | null, opts: { yieldedTo?: string | null; gpuHeld?: boolean } = {}): string => {
  if (!s) return "Reading…";
  if (!s.enabled) return "Off · device defaults";
  if (s.blocked) return join(["Paused", firstSentence(s.blocked, 60)]);
  const x = v ?? s.values;
  const gpu = s.range.gpu_min != null && s.range.gpu_max != null && s.range.gpu_max > s.range.gpu_min
    ? (x.gpu_min_mhz == null && x.gpu_max_mhz == null ? "GPU default" : `GPU ${mhz(x.gpu_min_mhz)}–${mhz(x.gpu_max_mhz)} MHz`) : null;
  return join([
    x.pl1_w == null ? "default" : watts(x.pl1_w),
    `boost ${x.pl2_w == null ? "default" : watts(x.pl2_w)}`,
    gpu, profileName(s),
    opts.yieldedTo ? `Left to ${opts.yieldedTo}` : null,
    opts.gpuHeld ? "GPU held back" : null,
  ]);
};

const SCX_NAME: Record<ScxMode, string> = { auto: "Auto", gaming: "Gaming", powersave: "Power save" };

/** "Cap 60 % · Boost off · Scheduler Gaming"; "Power control off · Scheduler Gaming" while it is off. */
export const cpuSummary = (s: PowerState | null, info: PowerInfo | null, v: PowerValues | null, scx: ScxMode | null | undefined, x: ExtrasState | null): string => {
  const sched = x?.scx.shown ? `Scheduler ${scx ? SCX_NAME[scx] : "as it is"}` : null;
  if (!s) return "Reading…";
  if (!s.enabled) return join(["Power control off", sched]);
  const cpu = info?.hw.cpu ?? null;
  const vv = v ?? s.values;
  const cap = !cpu?.perf_pct ? null : usesCaps(vv) ? "Per-core caps" : `Cap ${vv.cpu_max_pct ?? s.now.cpu_max_pct ?? 100} %`;
  const boost = cpu?.turbo ? `Boost ${(vv.turbo ?? s.now.turbo ?? true) ? "on" : "off"}` : null;
  return join([cap, boost, sched]) || "CPU controls";
};

const FAN_NAME = { auto: "Auto", quiet: "Quiet", max: "Max" } as const;

/** "Fan Auto · Charge to 80 % · Battery idle on charger". */
export const batterySummary = (x: ExtrasState | null, fan: PowerValues["fan_mode"] | undefined): string => {
  if (!x) return "Reading…";
  const c = x.charge;
  const limit = x.options.charge_limit ?? c.limit ?? 100;
  const awake = (x.options.charge_behaviour ?? c.behaviour) === "inhibit-charge-awake";
  return join([
    x.fan.available ? `Fan ${FAN_NAME[fan ?? "auto"]}` : null,
    c.available ? (limit >= 100 ? "Charges fully" : `Charge to ${limit} %`) : null,
    c.available && awake ? "Battery idle on charger" : null,
    x.fan.available && x.fan.reverted ? firstSentence(x.fan.reverted, 40) : null,
  ]) || "Fan and battery";
};

/** The XeSS status row: label, one line up front, and the longer text for its Details. */
export const xessLine = (x: XessSummary | null | undefined): { ok: boolean | null; label: string; detail: string; more: string } => {
  const what = "Fast mode runs XeSS upscaling and frame generation on the GPU's XMX cores (xess-xmx-linux) instead of the slower DP4a path.";
  if (!x) return { ok: null, label: "XeSS fast mode: …", detail: "", more: what };
  if (!x.installed) return { ok: false, label: "XeSS fast mode: Off", detail: "Not installed. Games use the slower mode.", more: what };
  const v = x.version ? ` (${x.version})` : "";
  if (x.relogin_needed) return { ok: null, label: "XeSS fast mode: Log out needed", detail: "Log out and back in to turn it on.", more: `Installed${v}, but Steam still runs with the old driver setting: log out and back in (or reboot). ${what}` };
  if (x.status === "failed") return { ok: false, label: "XeSS fast mode: Off", detail: "The fast driver failed its check.", more: `${x.line ?? "The session check fell back to the system driver: games use DP4a."}${v} ${what}` };
  if (x.status === "unknown") return { ok: null, label: "XeSS fast mode: Not checked", detail: "Checked at the next log-in.", more: `Installed${v}. The driver check runs at the next log-in. ${what}` };
  return x.live ? { ok: true, label: "XeSS fast mode: On", detail: `Installed${v}`, more: `${x.line ?? "The fast driver is the session's graphics driver."} ${what}` }
    : { ok: null, label: "XeSS fast mode: Log out needed", detail: "Log out and back in to turn it on.", more: `Installed${v}; the session does not use the fast driver yet. ${what}` };
};

/** "On (20261104) · Update available" / "Log out needed" / "✗ Off · driver check failed". */
export const xessSummary = (x: XessSummary | null | undefined, update: boolean): string => {
  if (!x) return "Reading…";
  const label = xessLine(x).label.replace(/^XeSS fast mode: /, "");
  const failed = x.installed && !x.relogin_needed && x.status === "failed";
  const head = failed ? "✗ Off · driver check failed" : label === "On" && x.version ? `On (${x.version})` : label;
  return join([head, update ? "Update available" : null]);
};

/** "7 applied · 2 recommended" / "Fixes tool not installed". */
export const fixesSummary = (f: { installed: boolean; usable: boolean; update: boolean; applied: number | null; recommended: number; attention: number }): string => {
  if (!f.installed) return "Fixes tool not installed";
  if (!f.usable) return "Fixes tool too old";
  if (f.applied === null) return join(["Reading…", f.update ? "Update available" : null]);
  return join([
    `${f.applied} applied`,
    f.recommended ? `${f.recommended} recommended` : null,
    f.attention ? `${f.attention} need attention` : null,
    !f.recommended && !f.attention ? "up to date" : null,
    f.update ? "Update available" : null,
  ]);
};

// ---- pinned problems (an action's error that survives closing its group) --------------------------------------------

/**
 * The errors pinned to each group, by owner (one hook instance). `drop(group, owner, open)`: the owner unmounts; its
 * error stays only when that is because its group closed (open false), not when the group is open (the panel left,
 * the row went away), so an open group never keeps a red header nobody can clear.
 */
export const makePins = () => {
  const m = new Map<GroupId, Map<number, string>>();
  const changed = (g: GroupId, owner: number, error: string | null): boolean => {
    const k = m.get(g) ?? new Map<number, string>();
    if (error) { if (k.get(owner) === error) return false; k.set(owner, error); }
    else if (!k.delete(owner)) return false;
    m.set(g, k);
    return true;
  };
  return {
    /** Records (or with null removes) the owner's error; true: something changed. */
    set: (g: GroupId, owner: number, error: string | null | undefined) => changed(g, owner, error || null),
    drop: (g: GroupId, owner: number, open: boolean) => (open ? changed(g, owner, null) : false),
    clear: (g: GroupId): boolean => { if (!m.get(g)?.size) return false; m.delete(g); return true; },
    of: (g: GroupId): string[] => [...(m.get(g)?.values() ?? [])],
  };
};

/**
 * A refused "Power control (TDP)" enable's conflicts that still stand: the fresh power-info's copy of each, and
 * none that has been fixed since (a Fix for me removes it); none once power control is on.
 */
export const refusedLive = (refused: PowerConflict[], info: PowerInfo | null, enabled = false): PowerConflict[] =>
  enabled ? [] : refused.map((c) => info?.conflicts.find((x) => x.id === c.id) ?? c)
    .filter((c) => info?.conflicts.some((x) => x.id === c.id) || !(info?.fixed ?? []).some((f) => f.id === c.id));
