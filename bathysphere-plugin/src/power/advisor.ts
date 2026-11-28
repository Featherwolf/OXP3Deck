// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Power tips while playing (original sampler.py): while a game runs with power control on and the
 * powerTips setting on, a cheap sensor read every 5 s (no GPU clocks) is counted per game and per
 * "<sustained W>|ac|bat"; the first 30 s after a start, a wake or a change are left out. After 5 min
 * at the same sustained power there may be one tip. Nothing is ever written here: only the user's
 * "Use N W" changes the sustained power. Kept in memory for this session only.
 */
import { host } from "@bathysphere/sdk";
import { after, now, nowSeconds, type Timer } from "../core/clock";
import { redraw } from "../core/redraw";
import { int, isAppidKey, isObj, Stored, type Obj } from "../core/storage";
import { batteryNow } from "../device/info";
import { readSensors } from "./live";

export const SAMPLE_MS = 5000;
export const LOAD_SKIP_MS = 30_000;
export const MIN_PLAY_S = 300;
const PKG_BINS = 61;
const BUSY_BINS = 11;
const MAX_APPS = 50;
const MAX_DISMISSED = 200;
export const KINDS = ["headroom", "raise", "plug", "cpu"] as const;
export type AdviceKind = (typeof KINDS)[number];

export interface Bucket {
  secs: number;
  n: number;
  pkgSum: number;
  pkgHist: number[];
  busySum: number;
  busyHist: number[];
  limitedN: number;
  thermalN: number;
}

export const newBucket = (): Bucket => ({ secs: 0, n: 0, pkgSum: 0, pkgHist: Array(PKG_BINS).fill(0), busySum: 0, busyHist: Array(BUSY_BINS).fill(0), limitedN: 0, thermalN: 0 });

export interface Stats {
  avgPackageW: number;
  p90PackageW: number;
  avgGpuBusyPct: number;
  p90GpuBusyPct: number;
  limitedShare: number;
  thermalShare: number;
}

/** The upper edge of the bin holding the 90th percentile. */
function p90(hist: number[], width: number, top: number): number {
  const n = hist.reduce((a, b) => a + b, 0);
  if (!n) return 0;
  const need = Math.ceil(0.9 * n);
  let run = 0;
  for (let i = 0; i < hist.length; i++) {
    run += hist[i]!;
    if (run >= need) return Math.min(top, (i + 1) * width);
  }
  return top;
}

export function stats(b: Bucket): Stats {
  const n = b.n || 1;
  return {
    avgPackageW: Math.round((b.pkgSum / n) * 10) / 10,
    p90PackageW: p90(b.pkgHist, 1, PKG_BINS),
    avgGpuBusyPct: Math.round((b.busySum / n) * 10) / 10,
    p90GpuBusyPct: p90(b.busyHist, 10, 100),
    limitedShare: Math.round((b.limitedN / n) * 1000) / 1000,
    thermalShare: Math.round((b.thermalN / n) * 1000) / 1000,
  };
}

export interface AdviceContext {
  tdpW: number;
  tdpMin: number;
  /** The highest sustained power on this power source. */
  tdpMax: number;
  /** The highest plugged in (an admin AC limit), when higher than on battery. */
  tdpMaxAc: number | null;
  ac: boolean;
}

export interface Advice {
  kind: AdviceKind;
  tdpW: number;
  suggestW: number | null;
  tdpMaxAc: number | null;
  seconds: number;
  stats: Stats;
}

/** One bucket's tip (sampler.py _advise): none before 5 min or when nothing applies. */
export function advise(b: Bucket | undefined, g: AdviceContext): Advice | null {
  if (!b || b.secs < MIN_PLAY_S || !b.n) return null;
  const st = stats(b);
  const limited = b.limitedN / b.n;
  const busyMean = b.busySum / b.n;
  const pl1 = g.tdpW;
  let kind: AdviceKind | null = null;
  let suggest: number | null = null;
  if (limited < 0.1 && st.p90GpuBusyPct < 85 && st.p90PackageW <= pl1 - 4) {
    const s = Math.max(g.tdpMin || 5, Math.min(pl1 - 3, Math.ceil(st.p90PackageW) + 2));
    if (pl1 - s >= 3) [kind, suggest] = ["headroom", s];
  } else if (limited >= 0.5 && busyMean >= 90) {
    if (pl1 <= g.tdpMax - 2) [kind, suggest] = ["raise", Math.min(g.tdpMax, pl1 + 5)];
    else if (!g.ac && (g.tdpMaxAc ?? 0) > pl1) kind = "plug";
    else kind = "cpu";
  }
  return kind ? { kind, tdpW: pl1, suggestW: suggest, tdpMaxAc: g.tdpMaxAc, seconds: Math.floor(b.secs), stats: st } : null;
}

// ---- sampling -------------------------------------------------------------------------------------

const apps = new Map<number, { at: number; buckets: Map<string, Bucket> }>();
let timer: Timer | undefined;
let ctxKey = "";
let skipUntil = 0;
let prevAt: number | null = null;
let lastCtx: (AdviceContext & { app: number }) | null = null;
let sampledAt: number | null = null;

export const bucketName = (tdpW: number, ac: boolean): string => `${tdpW}|${ac ? "ac" : "bat"}`;

/** Counts one sample (sampler.py _count). */
export function count(b: Bucket, tdpW: number, dt: number, pkg: number, busy: number, reasons: readonly string[], throttled: boolean): void {
  b.secs = Math.round((b.secs + dt) * 10) / 10;
  b.n += 1;
  b.pkgSum = Math.round((b.pkgSum + pkg) * 100) / 100;
  b.pkgHist[Math.min(PKG_BINS - 1, Math.max(0, Math.floor(pkg)))]! += 1;
  b.busySum = Math.round((b.busySum + busy) * 10) / 10;
  b.busyHist[Math.min(BUSY_BINS - 1, Math.max(0, Math.floor(busy / 10)))]! += 1;
  if (reasons.includes("pl1") || reasons.includes("pl2") || pkg >= tdpW - 1) b.limitedN += 1;
  if (reasons.includes("thermal") || reasons.includes("prochot") || throttled) b.thermalN += 1;
}

async function tick(wanted: () => number | null): Promise<void> {
  timer = undefined;
  const app = wanted();
  if (app === null) {
    prevAt = null;
    return;
  }
  timer = after(SAMPLE_MS, () => void tick(wanted));
  try {
    const tdp = await host.system.tdp.get();
    const ac = batteryNow()?.ac ?? false;
    const key = `${app}|${bucketName(tdp.watts, ac)}`;
    if (key !== ctxKey) {
      ctxKey = key;
      skipUntil = now() + LOAD_SKIP_MS;
    }
    lastCtx = {
      app,
      tdpW: tdp.watts,
      tdpMin: tdp.min,
      tdpMax: !ac && tdp.capped === "battery" && tdp.effective !== undefined ? tdp.effective : tdp.max,
      tdpMaxAc: tdp.capped === "battery" ? tdp.max : null,
      ac,
    };
    const t = now();
    const dt = prevAt === null ? null : (t - prevAt) / 1000;
    prevAt = t;
    const smp = await readSensors(false);
    const s = smp.s;
    // a stall or a wake: only a new baseline (sampler.py: 0.5 to 3 sample periods)
    if (dt === null || dt < SAMPLE_MS / 2000 || dt > (3 * SAMPLE_MS) / 1000) return;
    if (t < skipUntil || s.packageW === undefined || s.gpu?.busyPct === undefined) return;
    let rec = apps.get(app);
    if (!rec) {
      rec = { at: t, buckets: new Map() };
      apps.set(app, rec);
      if (apps.size > MAX_APPS) {
        const oldest = [...apps.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
        apps.delete(oldest[0]);
      }
    }
    rec.at = t;
    const name = bucketName(tdp.watts, ac);
    const b = rec.buckets.get(name) ?? newBucket();
    rec.buckets.set(name, b);
    count(b, tdp.watts, dt, s.packageW, s.gpu.busyPct, s.gpu.reasons ?? [], (smp.throttledMs ?? 0) > 0);
    sampledAt = t;
    redraw();
  } catch {
    // no sensors or no TDP control right now: try again at the next sample
  }
}

/**
 * Starts or stops sampling. `wanted` returns the game to sample, or null when tips should not
 * sample now (no game, power control off, the setting off, not an ONEXPLAYER 3).
 */
export function syncAdvisor(wanted: () => number | null): void {
  if (wanted() === null) {
    timer?.cancel();
    timer = undefined;
    prevAt = null;
    return;
  }
  if (!timer) timer = after(SAMPLE_MS, () => void tick(wanted));
}

/** After a wake or a profile change: the next 30 s are not counted. */
export function restartWindow(): void {
  ctxKey = "";
}

// ---- dismissals and the tip --------------------------------------------------------------------

interface Dismissal {
  kind: AdviceKind;
  tdpW: number;
  at: number;
}

function normAdvisor(raw: Obj): { dismissed: Record<string, Dismissal> } {
  const out: Array<[string, Dismissal]> = [];
  if (isObj(raw.dismissed)) {
    for (const [k, d] of Object.entries(raw.dismissed)) {
      if (!isAppidKey(k) || !isObj(d) || !(KINDS as readonly unknown[]).includes(d.kind)) continue;
      const tdpW = int(d.tdpW, 1, 200);
      if (tdpW !== null) out.push([k, { kind: d.kind as AdviceKind, tdpW, at: int(d.at, 0, 2 ** 40) ?? 0 }]);
    }
  }
  out.sort((a, b) => b[1].at - a[1].at);
  return { dismissed: Object.fromEntries(out.slice(0, MAX_DISMISSED)) };
}

export const advisorStore = new Stored("advisor", "Dismissed power tips", 1, normAdvisor);

export interface TipView {
  advice: Advice | null;
  /** Seconds counted at the current sustained power. */
  seconds: number;
  sampling: boolean;
}

/** The tip for a running game now. */
export function tipFor(appid: number): TipView {
  const ctx = lastCtx && lastCtx.app === appid ? lastCtx : null;
  const b = ctx ? apps.get(appid)?.buckets.get(bucketName(ctx.tdpW, ctx.ac)) : undefined;
  const sampling = !!timer && sampledAt !== null && now() - sampledAt <= 3 * SAMPLE_MS;
  if (!ctx) return { advice: null, seconds: 0, sampling };
  let a = advise(b, ctx);
  const d = advisorStore.value.dismissed[String(appid)];
  if (a && d && d.kind === a.kind && d.tdpW === a.tdpW) a = null;
  return { advice: a, seconds: b ? Math.floor(b.secs) : 0, sampling };
}

export async function dismissTip(appid: number, a: Advice): Promise<void> {
  const dismissed = { ...advisorStore.value.dismissed, [String(appid)]: { kind: a.kind, tdpW: a.tdpW, at: nowSeconds() } };
  await advisorStore.save(normAdvisor({ dismissed }));
}

/** The tip's line (original adviceLine). */
export function adviceLine(a: Advice): string {
  const now = `${a.tdpW} W`;
  switch (a.kind) {
    case "headroom":
      return `GPU has headroom: ${a.suggestW} W would likely keep your fps (now ${now})`;
    case "raise":
      return `Power-limited at ${now}: ${a.suggestW} W may give more fps`;
    case "plug":
      return `Power-limited at ${now}: plug in for up to ${a.tdpMaxAc} W`;
    default:
      return `Power-limited at ${now}: a lower CPU speed cap leaves the GPU more`;
  }
}

/** The tip's Details paragraphs (original adviceDetails). */
export function adviceDetails(a: Advice): string[] {
  const st = a.stats;
  const out = [
    `Over ${Math.max(1, Math.round(a.seconds / 60))} min at ${a.tdpW} W: ${st.avgPackageW} W on average (90 % of the time under ${st.p90PackageW} W), GPU busy ${Math.round(st.avgGpuBusyPct)} %, held back by the power limit ${Math.round(st.limitedShare * 100)} % of the time.`,
  ];
  if (a.kind === "headroom") out.push("A lower limit usually keeps a frame-capped game at the same fps and saves battery. If fps drops, tap Undo or move the slider.");
  if (a.kind === "raise") out.push("The game uses all the power it gets and the GPU is busy nearly all the time: a higher limit may give more fps, and costs battery.");
  if (a.kind === "plug") out.push(`On battery the limit stops at ${a.tdpW} W; plugged in it can go up to ${a.tdpMaxAc} W.`);
  if (a.kind === "cpu") out.push("The limit is at its top. A lower CPU speed cap (CPU group) leaves more of the power to the GPU.");
  if (st.thermalShare > 0.1) out.push(`It was also held back by heat ${Math.round(st.thermalShare * 100)} % of the time.`);
  out.push("Nothing changes until you tap the button. Sustained power is Steam's own setting: Steam's per-game profile keeps it for this game.");
  return out;
}
