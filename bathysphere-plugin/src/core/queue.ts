// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Calls the host rate-limits (SPEC §5.3), queued so the limits are never hit:
 * - every `system.*.set` (profiles included) one at a time, each method at most 2/s, profiles 1/s,
 *   charge limit and behaviour 1 per 10 s; a newer value for the same key replaces one still
 *   waiting (latest wins) and its caller gets the newer call's outcome;
 * - toasts 1/s and 10/min, a repeat of the last one dropped;
 * - `steam.gamefiles.find` one at a time, 1/s.
 */
import { host, log, type HostError } from "@bathysphere/sdk";
import { after, now, type Timer } from "./clock";
import { asHostError } from "./errors";

export type Outcome = { ok: true } | { ok: false; error: HostError };

interface Job {
  key: string;
  method: string;
  run: () => Promise<unknown>;
  waiters: Array<(o: Outcome) => void>;
  retries: number;
}

const GAP_MS: Record<string, number> = {
  "system.profiles.set": 1000,
  "system.chargeLimit.set": 10_000,
  "system.chargeBehaviour.set": 10_000,
};
const DEFAULT_GAP_MS = 500;
/**
 * Waits are measured on `now()` but the host counts its windows on its own clock; a little extra
 * keeps a call that waited exactly one window from landing a few ms inside it.
 */
const MARGIN_MS = 50;
/** ERATE from a limit this queue does not model (another caller's window): try again later. */
const RATE_RETRY_MS = 1000;
const RATE_RETRIES = 2;

const jobs: Job[] = [];
const lastStart = new Map<string, number>();
let running = false;
let wake: Timer | undefined;

const due = (j: Job): number => (lastStart.get(j.method) ?? -Infinity) + (GAP_MS[j.method] ?? DEFAULT_GAP_MS);

async function pump(): Promise<void> {
  if (running || jobs.length === 0) return;
  const t = now();
  const ready = jobs.find((j) => due(j) <= t);
  if (!ready) {
    const next = Math.min(...jobs.map(due));
    wake?.cancel();
    wake = after(Math.max(1, next - t) + MARGIN_MS, () => {
      wake = undefined;
      void pump();
    });
    return;
  }
  jobs.splice(jobs.indexOf(ready), 1);
  running = true;
  lastStart.set(ready.method, now());
  let outcome: Outcome;
  try {
    await ready.run();
    outcome = { ok: true };
  } catch (e) {
    const err = asHostError(e);
    if (err.code === "ERATE" && ready.retries < RATE_RETRIES) {
      ready.retries++;
      lastStart.set(ready.method, now() + RATE_RETRY_MS - (GAP_MS[ready.method] ?? DEFAULT_GAP_MS));
      jobs.unshift(ready);
      running = false;
      void pump();
      return;
    }
    outcome = { ok: false, error: err };
  }
  running = false;
  for (const w of ready.waiters) w(outcome);
  void pump();
}

/**
 * Queues one hardware write. `key` names what it changes (a knob, "rules"): a job with the same key
 * that has not started yet is replaced by this one.
 */
export function hwWrite(key: string, method: string, run: () => Promise<unknown>): Promise<Outcome> {
  return new Promise((resolve) => {
    const waiting = jobs.find((j) => j.key === key);
    if (waiting) {
      waiting.run = run;
      waiting.method = method;
      waiting.waiters.push(resolve);
    } else {
      jobs.push({ key, method, run, waiters: [resolve], retries: 0 });
    }
    void pump();
  });
}

/** True while a write for `key` waits or runs (rows show "Applying…"). */
export const hwPending = (key: string): boolean => jobs.some((j) => j.key === key);

// ---- toasts --------------------------------------------------------------------------------------

const TOAST_GAP_MS = 1100;
const TOASTS_PER_MIN = 10;
const toastTimes: number[] = [];
const toastQueue: Array<{ title: string; body?: string }> = [];
let lastToast = "";
let toastTimer: Timer | undefined;

function pumpToasts(): void {
  if (toastTimer || toastQueue.length === 0) return;
  const t = now();
  while (toastTimes.length && t - toastTimes[0]! >= 60_000) toastTimes.shift();
  const last = toastTimes[toastTimes.length - 1] ?? -Infinity;
  const wait = toastTimes.length >= TOASTS_PER_MIN ? toastTimes[0]! + 60_000 - t : last + TOAST_GAP_MS - t;
  if (wait > 0) {
    toastTimer = after(wait + MARGIN_MS, () => {
      toastTimer = undefined;
      pumpToasts();
    });
    return;
  }
  const next = toastQueue.shift()!;
  toastTimes.push(t);
  host.toasts.show(next.title, next.body).catch((e: unknown) => log.warn(`toast: ${asHostError(e).message}`));
  pumpToasts();
}

/** Shows a toast (title ≤ 64 chars, body ≤ 300), spaced to the host's limits. */
export function toast(title: string, body?: string): void {
  const sig = `${title}\u0000${body ?? ""}`;
  if (sig === lastToast && toastQueue.length === 0 && toastTimes.length && now() - toastTimes[toastTimes.length - 1]! < 10_000) return;
  lastToast = sig;
  toastQueue.push(body === undefined ? { title: title.slice(0, 64) } : { title: title.slice(0, 64), body: body.slice(0, 300) });
  pumpToasts();
}

// ---- serial work ---------------------------------------------------------------------------------

/** Runs async work one at a time with at least `gapMs` between starts (gamefiles.find: 1/s, 1 in flight). */
export function serial(gapMs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      const wait = last + gapMs - now();
      if (wait > 0) await new Promise<void>((r) => void after(wait + MARGIN_MS, r));
      last = now();
      return fn();
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  };
}
