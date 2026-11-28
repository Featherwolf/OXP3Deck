// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Remembered UI choices (storage `ui`; the original kept them per device with `remember`): which
 * Quick Access groups are open, the last panel tab, advanced CPU options, the first-use confirm of
 * power control, and the last game seen (the Games tab when none runs).
 */
import { bool, int, isObj, Stored, text, type Obj } from "../core/storage";

export type GroupId = "live" | "game" | "power" | "cpu" | "battery" | "xess" | "fixes";

/** In panel order; `open` is the default before the user toggles it (original quickgroups.ts). */
export const GROUPS: ReadonlyArray<{ id: GroupId; title: string; open: boolean }> = [
  { id: "live", title: "Live", open: false },
  { id: "game", title: "This game", open: true },
  { id: "power", title: "Power", open: true },
  { id: "cpu", title: "CPU", open: false },
  { id: "battery", title: "Fan & battery", open: false },
  { id: "xess", title: "XeSS", open: false },
  { id: "fixes", title: "Device fixes", open: false },
];

export const TAB_IDS = ["power", "cpu", "battery", "games", "xess", "fixes", "buttons", "kernel", "setup"] as const;
export type TabId = (typeof TAB_IDS)[number];

export interface UiPrefs {
  groups: Partial<Record<GroupId, boolean>>;
  tab: TabId;
  advancedCpu: boolean;
  powerConfirmed: boolean;
  lastGame: { appid: number; name: string } | null;
}

function normUi(raw: Obj): UiPrefs {
  const groups: Partial<Record<GroupId, boolean>> = {};
  if (isObj(raw.groups)) for (const g of GROUPS) if (typeof raw.groups[g.id] === "boolean") groups[g.id] = raw.groups[g.id] as boolean;
  const lg = isObj(raw.lastGame) ? raw.lastGame : null;
  const appid = lg ? int(lg.appid, 1, 4294967295) : null;
  return {
    groups,
    tab: (TAB_IDS as readonly unknown[]).includes(raw.tab) ? (raw.tab as TabId) : "power",
    advancedCpu: bool(raw.advancedCpu, false),
    powerConfirmed: bool(raw.powerConfirmed, false),
    lastGame: lg && appid !== null ? { appid, name: text(lg.name, 128) ?? `App ${appid}` } : null,
  };
}

export const prefs = new Stored<UiPrefs>("ui", "Display choices", 1, normUi);

export const groupOpen = (id: GroupId): boolean => prefs.value.groups[id] ?? GROUPS.find((g) => g.id === id)!.open;
