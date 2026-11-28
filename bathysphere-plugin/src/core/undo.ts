// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/** Undo rows that stay for 30 s after a one-tap change (presets, "Use N W"). */
import { after, type Timer } from "./clock";
import { redraw } from "./redraw";

export const UNDO_MS = 30_000;

interface Entry {
  label: string;
  run: () => Promise<void>;
  timer: Timer;
}

const entries = new Map<string, Entry>();

/** Offers an Undo under `key` for 30 s (a newer one replaces it). */
export function offerUndo(key: string, label: string, run: () => Promise<void>): void {
  entries.get(key)?.timer.cancel();
  entries.set(key, {
    label,
    run,
    timer: after(UNDO_MS, () => {
      entries.delete(key);
      redraw();
    }),
  });
}

export const undoLabel = (key: string): string | null => entries.get(key)?.label ?? null;

export async function runUndo(key: string): Promise<void> {
  const e = entries.get(key);
  if (!e) return;
  e.timer.cancel();
  entries.delete(key);
  await e.run();
}
