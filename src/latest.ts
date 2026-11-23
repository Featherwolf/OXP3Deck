// A latest-wins queue, framework-free so node can test it (tests/js/latest.test.mjs): the per-game profile switch
// (store.ts switchGame) sends one power_game at a time, in order, and drops the ones a newer game replaced.

export type LatestOpts<T, R> = {
  /** Every answer, with stale = true when a newer value was pushed while it was in flight. */
  onAnswer?: (answer: R, value: T, stale: boolean) => void;
  /** A send that threw or rejected, with stale as for onAnswer. */
  onError?: (error: unknown, value: T, stale: boolean) => void;
};

export type Latest<T> = {
  /** Queue value: it goes once the call in flight answers; a newer push replaces it while it waits. */
  push(value: T): void;
  busy(): boolean;                        // a call waits or is in flight
  /** Resolves once nothing waits or is in flight. */
  idle(): Promise<void>;
};

/**
 * One send at a time. push() while a send is in flight keeps only the newest value, which goes once that send
 * answers (a rejection or a throw too). seq goes up with every push, so the receiver can tell an old one apart.
 */
export const makeLatest = <T, R>(send: (value: T, seq: number) => Promise<R>, opts: LatestOpts<T, R> = {}): Latest<T> => {
  let seq = 0;
  let next: { value: T; seq: number } | null = null;
  let inflight = false;
  let waiting: (() => void)[] = [];

  const settle = () => {
    if (inflight || next) return;
    const w = waiting;
    waiting = [];
    for (const r of w) r();
  };

  const pump = () => {
    if (inflight || !next) return;
    const { value, seq: s } = next;
    next = null;
    inflight = true;
    const done = (fn: (stale: boolean) => void) => {
      inflight = false;
      const stale = seq !== s;
      try { fn(stale); } catch { /* a failing callback */ }
      pump();
      settle();
    };
    let p: Promise<R>;
    try { p = Promise.resolve(send(value, s)); } catch (e) { p = Promise.reject(e); }
    p.then((r) => done((stale) => opts.onAnswer?.(r, value, stale)),
      (e) => done((stale) => opts.onError?.(e, value, stale)));
  };

  return {
    push(value) {
      next = { value, seq: ++seq };
      pump();
    },
    busy: () => inflight || !!next,
    idle: () => (inflight || next ? new Promise<void>((r) => { waiting.push(r); }) : Promise.resolve()),
  };
};
