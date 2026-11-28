// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * oxp3-tool's fix catalog (assets/oxp3-tool-catalog.json, transcribed from oxp3-tool 0.4.4's
 * `list --json`): titles, levels, when each takes effect, the button keys and actions, and the
 * ranges of its options. Read once from the package.
 */
import { host } from "@bathysphere/sdk";
import { Cached } from "../core/cache";

export interface CatalogFix {
  id: string;
  group: "controller" | "display" | "audio" | string;
  level: "recommended" | "optional" | "experimental" | string;
  title: string;
  summary: string;
  details: string;
  takesEffect: string;
  karg?: string;
}

export interface Catalog {
  version: string;
  fixes: CatalogFix[];
  buttonKeys: Record<string, { label: string; default: string; stock: string; flag: string }>;
  buttonActions: Record<string, string>;
  fpsLimit: { min: number; max: number; default: number };
  minRefresh: { min: number; max: number; default: number };
}

export const catalog = new Cached<Catalog>(() => host.plugin.asset.json<Catalog>("assets/oxp3-tool-catalog.json"), Infinity);

/** The pinned release the install card downloads (manifest oxp3-tool-install). */
export const PINNED_VERSION = "0.4.4";

/** When a fix takes effect, from the catalog's words (original effects.ts fixEffect). */
export function effectText(f: CatalogFix): string {
  if (/reboot/i.test(f.takesEffect) && !/immediately/i.test(f.takesEffect)) return "after a reboot";
  if (/Game Mode starts/i.test(f.takesEffect)) return "after logging out of Game Mode";
  if (/suspend/i.test(f.takesEffect)) return "from the next sleep";
  return "at once";
}
