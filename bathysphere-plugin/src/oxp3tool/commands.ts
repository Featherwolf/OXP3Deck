// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Exact oxp3-tool command lines (pure) for the choices made on the Fixes and Buttons tabs. The
 * reviewed steps are the manifest's static cards (oxp3-tool-fix, oxp3-tool-buttons); these lines
 * fill in what a card cannot. Every value is checked against the catalog first, so only fix ids,
 * action names and numbers the tool knows can appear.
 */
import type { Catalog } from "./catalog";

const known = (c: Catalog, id: string): boolean => c.fixes.some((f) => f.id === id);

/** `sudo oxp3-tool apply <ids>` with options (lowest refresh rate, any SSD). */
export function applyLine(c: Catalog, ids: readonly string[], opts: { minRefresh?: number; anySsd?: boolean } = {}): string | null {
  if (!ids.length || !ids.every((id) => known(c, id))) return null;
  const parts = ["sudo oxp3-tool apply", ...ids];
  if (opts.minRefresh !== undefined) {
    if (!Number.isInteger(opts.minRefresh) || opts.minRefresh < c.minRefresh.min || opts.minRefresh > c.minRefresh.max) return null;
    parts.push(`--min-refresh ${opts.minRefresh}`);
  }
  if (opts.anySsd) parts.push("--any-ssd");
  return parts.join(" ");
}

export function revertLine(c: Catalog, id: string): string | null {
  return known(c, id) ? `sudo oxp3-tool revert ${id}` : null;
}

export interface ButtonChoice {
  actions: Record<string, string>;
  fpsLimit: number;
  xboxHelper: boolean;
  noRestart: boolean;
}

/** `sudo oxp3-tool apply buttons [xbox-key] --home … --keyboard-key … --onex-key … --xbox-key … [--fps-limit N] [--no-restart]`. */
export function buttonsLine(c: Catalog, b: ButtonChoice): string | null {
  const parts = ["sudo oxp3-tool apply buttons"];
  if (b.xboxHelper) parts.push("xbox-key");
  for (const [key, spec] of Object.entries(c.buttonKeys)) {
    const action = b.actions[key] ?? spec.default;
    if (!(action in c.buttonActions)) return null;
    parts.push(`${spec.flag} ${action}`);
  }
  if (Object.values(b.actions).includes("fps-limit")) {
    if (!Number.isInteger(b.fpsLimit) || b.fpsLimit < c.fpsLimit.min || b.fpsLimit > c.fpsLimit.max) return null;
    parts.push(`--fps-limit ${b.fpsLimit}`);
  }
  if (b.noRestart) parts.push("--no-restart");
  return parts.join(" ");
}

/** The button choices of the last apply (state.json fixes.buttons.options), else the catalog's defaults. */
export function savedButtons(c: Catalog, options: Record<string, unknown> | undefined): ButtonChoice {
  const saved = options && typeof options.actions === "object" && options.actions ? (options.actions as Record<string, unknown>) : {};
  const actions: Record<string, string> = {};
  for (const [key, spec] of Object.entries(c.buttonKeys)) {
    const a = saved[key];
    actions[key] = typeof a === "string" && a in c.buttonActions ? a : spec.default;
  }
  const fps = options?.fps_limit;
  return { actions, fpsLimit: typeof fps === "number" && fps >= c.fpsLimit.min && fps <= c.fpsLimit.max ? fps : c.fpsLimit.default, xboxHelper: false, noRestart: false };
}
