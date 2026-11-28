// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Time for the plugin. Timers run on the host's clock (`timer.set`/`timer`, SPEC §5.2), while `Date`
 * is the sandbox's own; on a device both agree. `now()` never runs behind a timer that has fired:
 * when one of our timers fires, the time it was due becomes the floor. So "60 s after the game
 * started" means the same thing to a timer and to a time difference, also under a host that moves
 * its clock by hand (the test host's manual clock).
 */

let floor = 0;
let floorSetAt = 0;

/** Unix milliseconds, never behind a fired timer. */
export function now(): number {
  const real = Date.now();
  return Math.max(real, floor + (real - floorSetAt));
}

/** Unix seconds (for `date` props and stored times). */
export const nowSeconds = (): number => Math.floor(now() / 1000);

export interface Timer {
  cancel(): void;
}

/** Runs `fn` once after `ms`. */
export function after(ms: number, fn: () => void): Timer {
  const due = now() + ms;
  let done = false;
  const id = setTimeout(() => {
    done = true;
    if (due > now()) {
      floor = due;
      floorSetAt = Date.now();
    }
    fn();
  }, ms);
  return {
    cancel() {
      if (!done) clearTimeout(id);
      done = true;
    },
  };
}

/** Waits `ms` on the host's clock. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => void after(ms, resolve));
