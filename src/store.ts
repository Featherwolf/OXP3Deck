// Answers shared by the quick panel and the full page. One request per key at a time, every component using a key
// re-renders when it lands, and a job that ends reloads everything (it may have changed any of it). Nothing here
// polls oxp3-tool: the backend runs one oxp3-tool at a time, so only job_status is polled, and only while a job runs
// and someone is looking at it.
import { useEffect, useReducer, useRef } from "react";

import { extras_info, job_status, power_live, power_set, power_state } from "./backend";
import type { EffectSpec } from "./effects";
import { makeWriter } from "./power";
import type { ExtrasInfoRes, Job, Live, PowerChangeRes, PowerFixRes, PowerInfoRes, PowerStateRes } from "./types";

type Entry = { data: unknown; inflight: Promise<unknown> | null; subs: Set<() => void>;
               loader: (() => Promise<unknown>) | null; stale: boolean };
const entries = new Map<string, Entry>();

const entry = (key: string): Entry => {
  let e = entries.get(key);
  if (!e) { e = { data: undefined, inflight: null, subs: new Set(), loader: null, stale: false }; entries.set(key, e); }
  return e;
};
const notify = (subs: Set<() => void>) => subs.forEach((f) => { try { f(); } catch { /* a dead subscriber */ } });

export const load = <T>(key: string, loader: () => Promise<T>): Promise<T> => {
  const e = entry(key);
  e.loader = loader;
  if (e.inflight) return e.inflight as Promise<T>;
  const p: Promise<T> = loader()
    .then((d) => { e.data = d; e.stale = false; return d; })
    .catch(() => e.data as T)
    .finally(() => { if (e.inflight === p) e.inflight = null; notify(e.subs); });
  e.inflight = p;
  notify(e.subs);
  return p;
};

export const peek = <T>(key: string): T | undefined => entries.get(key)?.data as T | undefined;

/** Replace the cached answer for key (an answer that came another way, e.g. the power writer's state). */
export const put = <T>(key: string, data: T) => {
  const e = entry(key);
  e.data = data;
  e.stale = false;
  notify(e.subs);
};

/**
 * The cached answer for key, loaded on first use. fresh: reload on every mount (the cached one shows meanwhile).
 * skip: do not load now (e.g. oxp3-tool status while a job holds oxp3-tool's lock); it loads once skip clears.
 */
export const useResource = <T>(key: string | null, loader: () => Promise<T>, opts: { fresh?: boolean; skip?: boolean } = {}) => {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(loader);
  latest.current = loader;
  const call = () => latest.current();
  useEffect(() => {
    if (!key) return undefined;
    const e = entry(key);
    e.subs.add(bump);
    if (!opts.skip && !e.inflight && (opts.fresh || e.data === undefined || e.stale)) load(key, call);
    return () => { e.subs.delete(bump); };
  }, [key, !!opts.skip]);
  const e = key ? entries.get(key) : undefined;
  return {
    data: e?.data as T | undefined,
    loading: !!e?.inflight,
    reload: (): Promise<T | undefined> => (key ? load(key, call) : Promise.resolve(undefined)),
  };
};

/**
 * Mark answers out of date: the ones on screen reload now, the others on their next use. Keys starting with
 * "manual:" (online update checks) are left alone: they run only when the user taps.
 */
export const invalidate = (prefix = "") => {
  entries.forEach((e, key) => {
    if (!key.startsWith(prefix) || (key.startsWith("manual:") && !prefix.startsWith("manual:"))) return;
    if (e.subs.size && e.loader) load(key, e.loader as () => Promise<unknown>);
    else e.stale = true;
  });
};

// ---- the job ------------------------------------------------------------------------------------------------------

let current: Job | null = null;
const jobSubs = new Set<() => void>();
const endSubs = new Set<(j: Job) => void>();
const afterSubs = new Map<string, ((j: Job) => void)[]>();
let pollers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let stopped = false;

/** The newest job this frontend knows about (running or the last one that ended). */
export const currentJob = () => current;
export const jobRunning = () => current?.state === "running";

/** Take a job from any answer (overview, JobStart, job_status); the end of a running one reloads the caches. */
export const noteJob = (j: Job | null | undefined) => {
  if (!j || !j.id) return;
  const prev = current;
  if (prev && prev.id !== j.id && j.started < prev.started) return;   // an older job than the one we follow
  current = j;
  notify(jobSubs);
  if (prev && prev.id === j.id && prev.state === "running" && j.state !== "running") {
    invalidate();
    endSubs.forEach((f) => { try { f(j); } catch { /* a dead subscriber */ } });
    const once = afterSubs.get(j.id) ?? [];
    afterSubs.delete(j.id);
    once.forEach((f) => { try { f(j); } catch { /* a failing callback */ } });
  }
  schedule();
};

/** The overview says no job runs: if we still think ours does, ask how it ended (it ended while nobody looked). */
export const syncJob = (running: Job | null | undefined) => {
  if (running) { noteJob(running); return; }
  const mine = current;
  if (mine?.state === "running") job_status(mine.id).then((r) => { if (r.ok && r.job) noteJob(r.job); });
};

const tick = async () => {
  timer = null;
  const j = current;
  if (!j || j.state !== "running" || pollers <= 0) return;
  const r = await job_status(j.id);
  if (r.ok && r.job) { failures = 0; noteJob(r.job); } else { failures++; }
  schedule();
};

const schedule = () => {
  if (stopped || timer || pollers <= 0 || current?.state !== "running") return;
  timer = setTimeout(tick, failures ? 5000 : 1500);   // a backend that does not answer: ask less often
};

/** Re-render on every change of the current job. */
export const useCurrentJob = (): Job | null => {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { jobSubs.add(bump); return () => { jobSubs.delete(bump); }; }, []);
  return current;
};

/** Poll job_status every 1.5 s while active (the panel is visible) and a job runs. */
export const useJobPolling = (active: boolean) => {
  useEffect(() => {
    if (!active) return undefined;
    pollers++;
    schedule();
    return () => { pollers--; };
  }, [active]);
};

/** fn(job) once, when job `id` (one this frontend follows) ends, whether a page is open or not. */
export const afterJob = (id: string, fn: (j: Job) => void) => {
  afterSubs.set(id, [...(afterSubs.get(id) ?? []), fn]);
};

/** fn(job) whenever a job this frontend followed ends. */
export const useJobEnded = (fn: (j: Job) => void) => {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const f = (j: Job) => latest.current(j);
    endSubs.add(f);
    return () => { endSubs.delete(f); };
  }, []);
};

// jobs shown next to the control that started them: the tab's own task section then leaves them out
const claimed = new Map<string, number>();
export const isClaimed = (id: string | null | undefined) => !!id && (claimed.get(id) ?? 0) > 0;
export const useClaim = (id: string | null | undefined) => {
  useEffect(() => {
    if (!id) return undefined;
    claimed.set(id, (claimed.get(id) ?? 0) + 1);
    notify(jobSubs);
    return () => {
      const n = (claimed.get(id) ?? 1) - 1;
      if (n > 0) claimed.set(id, n); else claimed.delete(id);
      notify(jobSubs);
    };
  }, [id]);
};

/** For onDismount: stop the poll timer. */
export const stopPolling = () => {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  liveStops.forEach((f) => { try { f(); } catch { /* already stopped */ } });
  liveStops.clear();
};

// ---- power ----------------------------------------------------------------------------------------------------------

/**
 * The one writer behind every power slider and toggle that sets profile values (power.ts makeWriter): changes reach
 * the backend in order, one at a time. Its answers update the cached power-state; the profiles reload afterwards.
 */
export const powerWriter = makeWriter(power_set, {
  onState: (state) => put<PowerStateRes>("power-state", { ok: true, error: null, state }),
  onAnswer: (r, stale) => {
    if (!stale) { invalidate("power-info"); extrasSoon(); }
    if (!r.ok) powerErrors.forEach((f) => { try { f(r.error); } catch { /* a dead subscriber */ } });
  },
});
const powerErrors = new Set<(e: string | null) => void>();

/** fn(error) when a change the writer sent was refused. */
export const usePowerErrors = (fn: (e: string | null) => void) => {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const f = (e: string | null) => latest.current(e);
    powerErrors.add(f);
    return () => { powerErrors.delete(f); };
  }, []);
};

/** A power change's answer into the caches (power-state now, the profiles and the overview on their next use). */
export const notePower = (r: PowerChangeRes): string | null => {
  if (r.state) put<PowerStateRes>("power-state", { ok: true, error: null, state: r.state });
  invalidate("power-info");
  invalidate("overview");
  extrasSoon();
  return r.ok ? null : r.error || "refused";
};

/** How long after a fix or undo power-info reloads once more: after the backend's own recheck (+10 s). */
export const FIX_RELOAD_MS = 12000;

/**
 * A Fix for me / Undo answer into the caches: the conflict rows, the records and the state from the answer at once
 * (only when the backend answered with them), and power-info once more after FIX_RELOAD_MS, so a unit that a program
 * started again shows as "came back" without a manual "Check again".
 */
export const notePowerFix = (r: PowerFixRes): string | null => {
  if (r.state) put<PowerStateRes>("power-state", { ok: true, error: null, state: r.state });
  const cur = peek<PowerInfoRes>("power-info");
  if (r.state && cur?.ok && cur.info && Array.isArray(r.conflicts) && Array.isArray(r.fixed)) {
    put<PowerInfoRes>("power-info", { ...cur, info: { ...cur.info, conflicts: r.conflicts, fixed: r.fixed, state: r.state } });
  } else {
    invalidate("power-info");
  }
  invalidate("overview");
  setTimeout(() => invalidate("power-info"), FIX_RELOAD_MS);
  return r.ok ? null : r.error || "refused";
};

/** For a panel closing and onDismount: send what the sliders still hold. */
export const flushPower = () => { try { powerWriter.flush(); } catch { /* the backend is going away */ } };

/** A poll answer from before a change the writer made (or while one waits) is dropped: it would move a slider back. */
const loadPowerState = async (): Promise<PowerStateRes | undefined> => {
  const v = powerWriter.version();
  const r = await power_state();
  return powerWriter.busy() || powerWriter.version() !== v ? peek<PowerStateRes>("power-state") ?? r : r;
};

/**
 * The live power state (it reads the GPU clocks, which wakes the GPU): loaded on mount and every 2 s, only while
 * active (the panel or the tab shows), never otherwise. Unmounting or going inactive sends what the writer holds.
 */
export const usePowerState = (active: boolean) => {
  const res = useResource<PowerStateRes | undefined>("power-state", loadPowerState, { skip: !active, fresh: true });
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { if (!powerWriter.busy()) load("power-state", loadPowerState); }, 2000);
    return () => { clearInterval(t); flushPower(); };
  }, [active]);
  return res;
};

// ---- live readouts (DESIGN.md "Live readouts") --------------------------------------------------------------------

/** How often the live readouts are read while a panel shows them. */
export const LIVE_MS = 1000;
const liveStops = new Set<() => void>();
type LiveState = { live: Live | null; error: string | null };
// one poller for every panel that shows the readouts (the quick panel over the Power tab): samples closer than the
// backend's 0.2 s would read as null
const liveSubs = new Set<(n: LiveState) => void>();
let liveLast: LiveState = { live: null, error: null };
let liveHandle: ReturnType<typeof setTimeout> | null = null;
let liveBusy = false;

const liveStep = async () => {
  liveHandle = null;
  if (!liveSubs.size || stopped || liveBusy) return;
  liveBusy = true;
  const r = await power_live();
  liveBusy = false;
  liveLast = r.ok ? { live: r.live, error: null } : { live: null, error: r.error };
  liveSubs.forEach((f) => { try { f(liveLast); } catch { /* a dead subscriber */ } });
  if (liveSubs.size && !stopped && !liveHandle) liveHandle = setTimeout(liveStep, LIVE_MS);
};
liveStops.add(() => { if (liveHandle) clearTimeout(liveHandle); liveHandle = null; liveSubs.clear(); });

/** The page is in front: false while Steam has it hidden (document.hidden; a game in front may hide it). */
export const usePageVisible = (): boolean => {
  const [v, set] = useReducer((_: boolean, n: boolean) => n, typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const f = () => set(!document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  return v;
};

/**
 * The live readouts: power_live() every LIVE_MS, only while mounted and `active` (the quick panel or the Power tab
 * shows), one call in flight at a time and one poller for all panels; stopped on unmount, when it goes inactive
 * and by stopPolling.
 */
export const useLive = (active: boolean): LiveState => {
  const [state, set] = useReducer((_: LiveState, n: LiveState) => n, { live: null, error: null });
  useEffect(() => {
    if (!active || stopped) return undefined;
    const f = (n: LiveState) => set(n);
    liveSubs.add(f);
    if (liveSubs.size > 1) set(liveLast);     // LIVE_MS of power_live() is already running
    else if (!liveHandle && !liveBusy) liveStep();
    return () => {
      liveSubs.delete(f);
      if (!liveSubs.size && liveHandle) { clearTimeout(liveHandle); liveHandle = null; }
    };
  }, [active]);
  return state;
};

// ---- extras (DESIGN.md "Extras") ----------------------------------------------------------------------------------

/** The extras' state, read again on every mount (cheap: the backend caches its D-Bus answers for 10 s). */
export const useExtras = () => useResource<ExtrasInfoRes>("extras-info", extras_info, { fresh: true });

/** An extras answer into the cache; its error text (or null). */
export const noteExtras = (r: ExtrasInfoRes): string | null => {
  if (r.extras) put<ExtrasInfoRes>("extras-info", r);
  else invalidate("extras-info");
  extrasSoon();
  return r.ok ? null : r.error || "refused";
};

let extrasTimer: ReturnType<typeof setTimeout> | null = null;
/** Reload extras-info 2 s after a power or extras change (the sync applied fan and scheduler; this catches lpmd). */
export const extrasSoon = () => {
  if (extrasTimer) clearTimeout(extrasTimer);
  extrasTimer = setTimeout(() => { extrasTimer = null; invalidate("extras-info"); }, 2000);
};

// ---- pending rows (DESIGN.md "When it takes effect": "Restart the game to apply", ...) -----------------------------

export type Pending = { id: string; effect: EffectSpec; label?: string; appid?: string | null; game?: string | null };
const pendings = new Map<string, Pending>();
const pendingSubs = new Set<() => void>();
const pendingKey = (p: Pick<Pending, "id" | "appid">) => `${p.id}@${p.appid ?? ""}`;

/** A change that takes effect later: its row shows under the control until it applies (or the frontend reloads). */
export const notePending = (p: Pending) => { pendings.set(pendingKey(p), p); notify(pendingSubs); };
/** Drop the pending rows of a setting (it was changed back, or it applied). */
export const clearPending = (id: string, appid?: string | null) => {
  if (pendings.delete(pendingKey({ id, appid }))) notify(pendingSubs);
};
/** `appid` started: its "Restart the game" rows are done. */
export const clearPendingFor = (appid: string | null) => {
  if (!appid) return;
  let changed = false;
  pendings.forEach((p, k) => { if (p.appid === appid) { pendings.delete(k); changed = true; } });
  if (changed) notify(pendingSubs);
};
/** The pending rows of these setting ids (for appid, when given), re-rendered on every change. */
export const usePending = (ids: string[], appid?: string | null): Pending[] => {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { pendingSubs.add(bump); return () => { pendingSubs.delete(bump); }; }, []);
  return [...pendings.values()].filter((p) => ids.includes(p.id) && (appid === undefined || (p.appid ?? null) === (appid ?? null)));
};
