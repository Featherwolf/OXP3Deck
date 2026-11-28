// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Re-rendering after background work (a read finished, an event arrived). Handlers need none: the
 * SDK re-renders after every UI event. The SDK coalesces overlapping refreshes per surface instance.
 */
import { currentPlugin, refresh } from "@bathysphere/sdk";
import { after, type Timer } from "./clock";

export function redraw(): void {
  void refresh();
}

/** True while any surface (panel, Quick Access tab, game section) of the plugin is open. */
export const anyOpen = (): boolean => (currentPlugin()?.openSurfaces() ?? []).some((s) => s.surface !== "modal");

/** The open surface instances, as `surface:id:inst` keys. */
export const openKeys = (): Set<string> =>
  new Set((currentPlugin()?.openSurfaces() ?? []).map((s) => `${s.surface}:${s.id}:${String(s.inst)}`));

const pending = new Map<string, Timer>();

/** Runs `fn` `ms` after the last call with the same key (slider moves, profile edits). */
export function debounce(key: string, ms: number, fn: () => void): void {
  pending.get(key)?.cancel();
  pending.set(
    key,
    after(ms, () => {
      pending.delete(key);
      fn();
    }),
  );
}
