// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The device check and the 60 s measurement (original selftest.py, power.py probe_plan/probe).
 * The check moves each control a small step, reads it back and puts it back, one write at a time
 * through the hardware queue; it needs an open surface and no running game. Every set needs an open
 * surface (SPEC §5.3), so the check stops when the last one closes; a value it could not put back
 * then is owed: written again as soon as a surface is open (housekeeping, or the row's Put back),
 * since nothing else restores a Steam knob (§4). Fan, charge limit and charge behaviour are skipped:
 * their first change needs a host confirm. Results go to storage `selftest` (the check and the last
 * 10 measurements).
 */
import { host, type HostError } from "@bathysphere/sdk";
import { nowSeconds, sleep } from "../core/clock";
import { asHostError, explain } from "../core/errors";
import { hwWrite } from "../core/queue";
import { anyOpen, redraw } from "../core/redraw";
import { int, isObj, num, Stored, text, type Obj } from "../core/storage";
import { batteryNow } from "../device/info";
import { hw, type HwSnapshot } from "../hw/knobs";
import { power, writeRules } from "./apply";
import { readSensors } from "./live";

export type Outcome = "ok" | "locked" | "ignored" | "unsupported" | "skipped" | "not_restored";
const OUTCOMES: readonly Outcome[] = ["ok", "locked", "ignored", "unsupported", "skipped", "not_restored"];

export interface Probe {
  id: string;
  label: string;
  outcome: Outcome;
  before: string | null;
  tried: string | null;
  read: string | null;
  why: string | null;
}

export interface Measure {
  at: number;
  seconds: number;
  appid: number | null;
  name: string | null;
  ac: boolean | null;
  tdpW: number | null;
  avgPackageW: number | null;
  maxPackageW: number | null;
  avgGpuBusyPct: number | null;
  avgBatteryW: number | null;
  /** Share of samples per GPU throttle reason. */
  reasons: Record<string, number>;
  cpuThrottleMs: number | null;
  stopped: string | null;
}

export interface SelftestData {
  test: { at: number; probes: Probe[]; stopped: string | null } | null;
  measures: Measure[];
}

const s = (v: unknown, max = 200): string | null => text(v, max);

function normProbe(r: unknown): Probe | null {
  if (!isObj(r) || !(OUTCOMES as readonly unknown[]).includes(r.outcome)) return null;
  const id = s(r.id, 40);
  if (!id) return null;
  return { id, label: s(r.label, 80) ?? id, outcome: r.outcome as Outcome, before: s(r.before), tried: s(r.tried), read: s(r.read), why: s(r.why) };
}

function normMeasure(r: unknown): Measure | null {
  if (!isObj(r)) return null;
  const at = int(r.at, 0, 2 ** 40);
  if (at === null) return null;
  const reasons: Record<string, number> = {};
  if (isObj(r.reasons)) for (const [k, v] of Object.entries(r.reasons)) if (/^[a-z0-9_]{1,32}$/.test(k) && typeof v === "number") reasons[k] = v;
  return {
    at,
    seconds: num(r.seconds) ?? 0,
    appid: int(r.appid, 1, 4294967295),
    name: s(r.name, 128),
    ac: typeof r.ac === "boolean" ? r.ac : null,
    tdpW: num(r.tdpW),
    avgPackageW: num(r.avgPackageW),
    maxPackageW: num(r.maxPackageW),
    avgGpuBusyPct: num(r.avgGpuBusyPct),
    avgBatteryW: num(r.avgBatteryW),
    reasons,
    cpuThrottleMs: num(r.cpuThrottleMs),
    stopped: s(r.stopped),
  };
}

function normSelftest(raw: Obj): SelftestData {
  const t = isObj(raw.test) ? raw.test : null;
  return {
    test: t && Array.isArray(t.probes) ? { at: int(t.at, 0, 2 ** 40) ?? 0, probes: t.probes.map(normProbe).filter((p): p is Probe => !!p).slice(0, 20), stopped: s(t.stopped) } : null,
    measures: Array.isArray(raw.measures) ? raw.measures.map(normMeasure).filter((m): m is Measure => !!m).slice(0, 10) : [],
  };
}

export const selftest = new Stored("selftest", "Device check results", 1, normSelftest);

/** The running task's title and log (the Setup & updates tab shows it). */
export const task: { title: string | null; log: string[]; running: boolean } = { title: null, log: [], running: false };
let stopReason: string | null = null;

function logLine(line: string): void {
  task.log.push(line);
  if (task.log.length > 200) task.log.splice(0, task.log.length - 200);
  redraw();
}

/** The check and the measurement stop when a game starts or the charger changes. */
export function interruptTask(why: string): void {
  if (task.running) stopReason = why;
}

const CLOSED = "OXP3 Deck was closed";

interface Step<T> {
  id: string;
  label: string;
  /** The value now (text for the result), or null when the control is not there. */
  read: (h: HwSnapshot) => T | null;
  /** The value to try. */
  next: (h: HwSnapshot, v: T) => T | null;
  set: (v: T) => Promise<unknown>;
  method: string;
  show: (v: T) => string;
  same: (a: T, b: T) => boolean;
}

const STEPS: Array<Step<any>> = [
  {
    id: "tdp", label: "Sustained power", method: "system.tdp.set",
    read: (h) => h.tdp.value?.watts ?? null,
    next: (h, v: number) => (v + 1 <= h.tdp.value!.max ? v + 1 : v - 1 >= h.tdp.value!.min ? v - 1 : null),
    set: (v: number) => host.system.tdp.set(v), show: (v: number) => `${v} W`, same: (a, b) => a === b,
  },
  {
    id: "boost", label: "Boost power", method: "system.boost.set",
    read: (h) => (h.boost.value ? { mode: h.boost.value.mode, watts: h.boost.value.watts, offsetW: h.boost.value.offsetW, effective: h.boost.value.effective } : null),
    next: (h, v) => {
      const b = h.boost.value!;
      if (!b.modes.includes("manual")) return null;
      const w = v.effective + 1 <= b.max ? v.effective + 1 : v.effective - 1;
      return w >= b.min ? { mode: "manual", watts: w, offsetW: 0, effective: w } : null;
    },
    set: (v) => host.system.boost.set(v.mode === "manual" ? { mode: "manual", watts: v.watts } : v.mode === "follow" ? { mode: "follow", offsetW: v.offsetW } : { mode: v.mode }),
    show: (v) => `${v.effective} W (${v.mode})`,
    // in firmware mode the effective value is the firmware's own choice: only the mode counts
    same: (a, b) => a.mode === b.mode && (a.mode === "manual" ? a.watts === b.watts : a.mode === "follow" ? a.offsetW === b.offsetW : true),
  },
  {
    id: "gpuRange", label: "GPU maximum speed", method: "system.gpu.range.set",
    read: (h) => (h.gpuRange.value ? { minMhz: h.gpuRange.value.minMhz, maxMhz: h.gpuRange.value.maxMhz } : null),
    next: (_h, v) => (v.maxMhz - 50 >= v.minMhz ? { minMhz: v.minMhz, maxMhz: v.maxMhz - 50 } : null),
    set: (v) => host.system.gpu.range.set(v), show: (v) => `${v.maxMhz} MHz`, same: (a, b) => a.minMhz === b.minMhz && a.maxMhz === b.maxMhz,
  },
  {
    id: "cpuLimits", label: "CPU speed cap", method: "system.cpuLimits.set",
    read: (h) => h.cpuLimits.value?.maxPerfPct ?? null,
    next: (h, v: number) => (v - 5 >= h.cpuLimits.value!.maxPerfPctMin ? v - 5 : v + 5 <= 100 ? v + 5 : null),
    set: (v: number) => host.system.cpuLimits.set({ maxPerfPct: v }), show: (v: number) => `${v} %`, same: (a, b) => a === b,
  },
  {
    id: "socBalance", label: "CPU vs GPU balance", method: "system.socBalance.set",
    read: (h) => (h.socBalance.value ? { balance: h.socBalance.value.balance, offset: h.socBalance.value.offset } : null),
    next: (h, v) => {
      const sb = h.socBalance.value!;
      const b = v.balance + 1 <= sb.balanceMax ? v.balance + 1 : v.balance - 1;
      return b >= sb.balanceMin ? { balance: b, offset: v.offset } : null;
    },
    set: (v) => host.system.socBalance.set(v), show: (v) => `${v.balance}`, same: (a, b) => a.balance === b.balance && a.offset === b.offset,
  },
  {
    id: "epp", label: "Energy preference", method: "system.epp.set",
    read: (h) => (h.epp.value ? { ...h.epp.value.byType } : null),
    next: (h, v: Record<string, string>) => {
      const e = h.epp.value!;
      const first = Object.values(v)[0];
      const other = e.available.find((x) => x !== first);
      return other ? Object.fromEntries(Object.keys(v).map((k) => [k, other])) : null;
    },
    set: (v: Record<string, string>) => host.system.epp.set(v), show: (v: Record<string, string>) => Object.values(v)[0] ?? "?", same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  },
];

function outcomeOf(e: HostError): Outcome {
  if (e.code === "ENOTSUP") return "unsupported";
  if (e.code === "EBUSY" && /locked/i.test(e.message)) return "locked";
  if (e.code === "EBUSY" && /not applied|read back|changed it/i.test(e.message)) return "ignored";
  return "skipped";
}

/** Values the check could not put back because no surface was open (by step id; until written). */
const owed = new Map<string, { step: Step<any>; before: unknown }>();

/** Writes the owed values back (needs an open surface); what fails stays owed. */
export async function putBackOwed(): Promise<void> {
  if (!owed.size) return;
  for (const [id, o] of [...owed]) {
    const w = await hwWrite(`probe:${id}`, o.step.method, () => o.step.set(o.before));
    if (w.ok) owed.delete(id);
  }
  hw.invalidate();
  redraw();
}

/** What is owed, in words: "Sustained power (was 17 W)". */
export const owedText = (): string[] => [...owed.values()].map((o) => `${o.step.label} (was ${o.step.show(o.before)})`);

async function probe(step: Step<any>): Promise<Probe> {
  const out: Probe = { id: step.id, label: step.label, outcome: "skipped", before: null, tried: null, read: null, why: null };
  hw.invalidate();
  await hw.load();
  const h = hw.value;
  const before = h ? step.read(h) : null;
  if (!h || before === null) return { ...out, outcome: "unsupported", why: "not on this device now" };
  const tried = step.next(h, before);
  out.before = step.show(before);
  if (tried === null) return { ...out, why: "no room for a step" };
  out.tried = step.show(tried);
  const w = await hwWrite(`probe:${step.id}`, step.method, () => step.set(tried));
  if (!w.ok) {
    logLine(`${step.label}: ${explain(w.error).line}`);
    return { ...out, outcome: outcomeOf(w.error), why: explain(w.error).line };
  }
  hw.invalidate();
  await hw.load();
  const got = hw.value ? step.read(hw.value) : null;
  out.read = got === null ? null : step.show(got);
  const took = got !== null && step.same(got, tried);
  const back = await hwWrite(`probe:${step.id}`, step.method, () => step.set(before));
  if (!back.ok && back.error.code === "EPERM") {
    // the last surface closed between the step and its put-back: owed until one opens
    owed.set(step.id, { step, before });
    stopReason = CLOSED;
    logLine(`${step.label}: not put back yet (${explain(back.error).line})`);
    return { ...out, outcome: "not_restored", why: CLOSED };
  }
  hw.invalidate();
  await hw.load();
  const after = hw.value ? step.read(hw.value) : null;
  if (!back.ok || after === null || !step.same(after, before)) {
    logLine(`${step.label}: did not go back (reads ${after === null ? "?" : step.show(after)})`);
    return { ...out, outcome: "not_restored", read: after === null ? null : step.show(after) };
  }
  logLine(`${step.label}: ${took ? "works" : "the device ignored the change"}`);
  return { ...out, outcome: took ? "ok" : "ignored" };
}

/** Runs the device check (refused while a game runs). */
export async function runCheck(gameRunning: boolean): Promise<string | null> {
  if (task.running) return "Another check is running.";
  if (gameRunning) return "Quit the game first: the check changes power limits for a moment.";
  task.running = true;
  task.title = "Device check";
  task.log = [];
  stopReason = null;
  const probes: Probe[] = [];
  try {
    for (const step of STEPS) {
      if (!stopReason && !anyOpen()) stopReason = CLOSED;
      if (stopReason) {
        probes.push({ id: step.id, label: step.label, outcome: "skipped", before: null, tried: null, read: null, why: stopReason });
        continue;
      }
      probes.push(await probe(step));
    }
    for (const id of ["fan", "chargeLimit", "chargeBehaviour"]) {
      probes.push({ id, label: id === "fan" ? "Fan" : id === "chargeLimit" ? "Charge limit" : "Run from charger", outcome: "skipped", before: null, tried: null, read: null, why: "needs a confirm in Bathysphere Home" });
    }
    await selftest.save({ ...selftest.value, test: { at: nowSeconds(), probes, stopped: stopReason } });
  } finally {
    // the probes held leases; the rules (or the defaults) take over again
    if (power.value.enabled) await writeRules();
    else {
      await hwWrite("release", "system.hardware.release", () => host.system.hardware.release(["boost", "epp", "cpuLimits", "socBalance", "gpuRange"]));
      // the release put the helper's knobs back to their defaults; only Steam's sustained power can still be owed
      for (const id of [...owed.keys()]) if (id !== "tdp") owed.delete(id);
    }
    task.running = false;
    redraw();
  }
  return null;
}

/** Measures 60 s (a sample every 2 s): idle, or the running game. */
export async function runMeasure(game: { appid: number; name: string } | null): Promise<string | null> {
  if (task.running) return "Another check is running.";
  task.running = true;
  task.title = game ? `Measuring ${game.name}` : "Measuring idle power";
  task.log = [];
  stopReason = null;
  const pkg: number[] = [];
  const busy: number[] = [];
  const bat: number[] = [];
  const reasons: Record<string, number> = {};
  let throttle = 0;
  let n = 0;
  let tdpW: number | null = null;
  try {
    tdpW = (await host.system.tdp.get()).watts;
  } catch {
    tdpW = null;
  }
  const start = nowSeconds();
  try {
    for (let i = 0; i < 30 && !stopReason; i++) {
      try {
        const smp = await readSensors(false);
        n++;
        if (smp.s.packageW !== undefined) pkg.push(smp.s.packageW);
        if (smp.s.gpu?.busyPct !== undefined) busy.push(smp.s.gpu.busyPct);
        if ((smp.s.battery?.drawW ?? 0) > 0) bat.push(smp.s.battery!.drawW!);
        for (const r of smp.s.gpu?.reasons ?? []) reasons[r] = (reasons[r] ?? 0) + 1;
        throttle += smp.throttledMs ?? 0;
      } catch (e) {
        logLine(`sensor read: ${asHostError(e).message}`);
      }
      if (i % 5 === 4) logLine(`${(i + 1) * 2} s`);
      await sleep(2000);
    }
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const m: Measure = {
      at: start,
      seconds: nowSeconds() - start,
      appid: game?.appid ?? null,
      name: game?.name ?? null,
      ac: batteryNow()?.ac ?? null,
      tdpW,
      avgPackageW: avg(pkg),
      maxPackageW: pkg.length ? Math.max(...pkg) : null,
      avgGpuBusyPct: avg(busy),
      avgBatteryW: avg(bat),
      reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, Math.round((v / Math.max(1, n)) * 100) / 100])),
      cpuThrottleMs: throttle,
      stopped: stopReason,
    };
    await selftest.save({ ...selftest.value, measures: [m, ...selftest.value.measures].slice(0, 10) });
  } finally {
    task.running = false;
    redraw();
  }
  return null;
}

const OUTCOME_SHORT: Record<Outcome, string> = { ok: "work", locked: "locked by firmware", ignored: "ignored by firmware", unsupported: "not supported", skipped: "skipped", not_restored: "not put back" };

/** "4 of 6 work · 1 locked by firmware · 3 skipped". */
export function checkLine(t: NonNullable<SelftestData["test"]>): { line: string; bad: boolean } {
  const tried = t.probes.filter((p) => p.outcome !== "skipped");
  const parts = [`${tried.filter((p) => p.outcome === "ok").length} of ${tried.length} work`];
  for (const k of ["not_restored", "locked", "ignored", "unsupported", "skipped"] as Outcome[]) {
    const c = t.probes.filter((p) => p.outcome === k).length;
    if (c) parts.push(`${c} ${OUTCOME_SHORT[k]}`);
  }
  if (t.stopped) parts.push("stopped");
  return { line: parts.join(" · "), bad: t.probes.some((p) => p.outcome === "not_restored") };
}

export function probeLine(p: Probe): string {
  switch (p.outcome) {
    case "ok":
      return `${p.label}: works${p.before && p.tried ? ` (${p.before} → ${p.tried})` : ""}`;
    case "locked":
      return `${p.label}: locked by firmware`;
    case "ignored":
      return `${p.label}: the device ignored the change${p.read ? ` (reads ${p.read})` : ""}`;
    case "unsupported":
      return `${p.label}: not supported here`;
    case "not_restored":
      return `${p.label}: did not go back${p.read ? ` (reads ${p.read})` : ""}`;
    default:
      return `${p.label}: not tried${p.why ? `: ${p.why}` : ""}`;
  }
}

/** "Idle on battery: 4.1 W average, 6.0 W peak, GPU 3 %". */
export function measureLine(m: Measure): string {
  const src = m.ac === true ? " plugged in" : m.ac === false ? " on battery" : "";
  const w = (x: number | null) => (x === null ? "?" : `${x.toFixed(1)} W`);
  const head = m.appid ? `${m.name ?? `App ${m.appid}`}${m.tdpW !== null ? ` at ${m.tdpW} W` : ""}` : `Idle${src}`;
  return `${head}: ${w(m.avgPackageW)} average, ${w(m.maxPackageW)} peak, GPU ${m.avgGpuBusyPct === null ? "?" : Math.round(m.avgGpuBusyPct)} %`;
}
