// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Other power programs (pure; original src/conflicts.ts and power.py CONFLICTS), keyed by the ids of
 * hostd's conflict table (SPEC §5.3 `system.power.conflicts`). Turning one off is root work, so each
 * names the step of the "Run this yourself" cards `power-off`, `power-on`, `decky-leftovers` or
 * `hhd-tdp` (manifest `contributes.instructions`) instead of a "Fix for me" button.
 */
import type { PowerConflict } from "@bathysphere/sdk";

export interface ConflictText {
  name: string;
  line: string;
  body: string[];
}

const LIMITS = "Also changes power limits, so yours may not hold.";
const CPU_LINE = "Controls energy preference and CPU boost.";

const TEXTS: Record<string, ConflictText> = {
  "power-profiles-daemon": {
    name: "Power Profiles",
    line: CPU_LINE,
    body: [
      "The desktop's power mode service. It sets the CPU's energy preference from the power mode you pick in Desktop Mode, so OXP3 Deck uses its power modes (Energy mode) instead of energy preference while it runs. Power limits and GPU speed still work.",
      "Turning it off: the power mode switch in Desktop Mode stops working, and so does profile switching by Steam or CachyOS's game launcher.",
    ],
  },
  tuned: {
    name: "TuneD",
    line: CPU_LINE,
    body: [
      "A system tuning service; tuned-ppd stands in for the desktop's power mode service. It sets the CPU's energy preference, so energy preference is left to it while it runs.",
      "Turning it off: the power mode switch in Desktop Mode stops working. Both parts are turned off: TuneD alone keeps its profile.",
    ],
  },
  intel_lpmd: {
    name: "Intel low-power daemon",
    line: "Controls energy preference and parks CPU cores.",
    body: [
      "Intel's low-power service. CachyOS turns it on for this CPU. It changes the energy preference and parks CPU cores during light work. It does not touch the power limits.",
      "Turning it off: light tasks and video use a bit more battery; games are fine. The original OXP3 Deck could pause it while a game runs; Bathysphere never controls it, so it is on or off.",
    ],
  },
  thermald: {
    name: "Thermal daemon",
    line: "Lowers the power limit on its own, so yours may not hold.",
    body: [
      "Intel's thermal service. On this CPU it rewrites the sustained power limit within seconds, so your limits do not hold while it runs.",
      "Turning it off: the CPU's own heat limit and the fan still protect the device; the case may get warmer at high power.",
    ],
  },
  powerstation: {
    name: "PowerStation",
    line: LIMITS,
    body: [
      "A power service on Bazzite that sets the same power limits as the hardware helper.",
      "Turning it off: a Bazzite system update may turn it back on; OXP3 Deck tells you when it runs again.",
    ],
  },
  "oxp3-tdp-sync": {
    name: "TDP sync script",
    line: LIMITS,
    body: ["A community script that copies one power limit into the other every 2 seconds. The hardware helper already writes both, so it is not needed."],
  },
  "onex3-tdp": { name: "onex3-tdp", line: LIMITS, body: ["Another script that sets the power limits."] },
  hhd: {
    name: "Handheld Daemon",
    line: "Its TDP setting also changes power limits.",
    body: [
      "Handheld Daemon's TDP and fan control set the same limits.",
      "Turn off TDP and fan control in Handheld Daemon's settings, then choose \"I've handled it\". It may run the controller, so it is not turned off.",
    ],
  },
  "decky-simpledeckytdp": {
    name: "SimpleDeckyTDP",
    line: LIMITS,
    body: ["A Decky Loader plugin that sets the same power limits. Its folder is still in ~/homebrew/plugins; remove it (Decky's plugins folder belongs to root)."],
  },
  "decky-powercontrol": {
    name: "PowerControl",
    line: LIMITS,
    body: ["A Decky Loader plugin that sets the same power limits. Its folder is still in ~/homebrew/plugins; remove it (Decky's plugins folder belongs to root)."],
  },
  "decky-powertools": {
    name: "PowerTools",
    line: LIMITS,
    body: ["A Decky Loader plugin that sets the same power limits. Its folder is still in ~/homebrew/plugins; remove it (Decky's plugins folder belongs to root)."],
  },
  "som-remote:local.oxp3.Tdp": {
    name: "oxp3-support's TDP remote",
    line: "Competes with the hardware helper for Steam's TDP slider.",
    body: ["The oxp3-support package gives Steam's TDP slider its own way to the power limits, next to the hardware helper's. Remove the package: the hardware helper replaces it."],
  },
};
TEXTS["tuned-ppd"] = TEXTS.tuned!;

/** The step of the `power-off` card per conflict id (manifest order: thermald, ppd, TuneD, lpmd, PowerStation, sync, onex3, oxp3-support). */
const OFF_STEP: Record<string, number> = {
  thermald: 0,
  "power-profiles-daemon": 1,
  tuned: 2,
  "tuned-ppd": 2,
  intel_lpmd: 3,
  powerstation: 4,
  "oxp3-tdp-sync": 5,
  "onex3-tdp": 6,
  "som-remote:local.oxp3.Tdp": 7,
};
/** The step of the `power-on` card (the same order, without oxp3-support). */
const ON_STEP: Record<string, number> = {
  thermald: 0,
  "power-profiles-daemon": 1,
  tuned: 2,
  "tuned-ppd": 2,
  intel_lpmd: 3,
  powerstation: 4,
  "oxp3-tdp-sync": 5,
  "onex3-tdp": 6,
};
const DECKY_STEP: Record<string, number> = { "decky-simpledeckytdp": 1, "decky-powercontrol": 2, "decky-powertools": 3 };

/** The "Run this yourself" card (instruction id and steps) that turns a conflict off, if any. */
export function offCard(id: string): { id: string; steps?: number[] } | null {
  if (id in OFF_STEP) return { id: "power-off", steps: [OFF_STEP[id]!] };
  if (id in DECKY_STEP) return { id: "decky-leftovers", steps: [0, DECKY_STEP[id]!] };
  if (id === "hhd") return { id: "hhd-tdp" };
  return null;
}

/** The card that turns it back on, if any. */
export function onCard(id: string): { id: string; steps: number[] } | null {
  return id in ON_STEP ? { id: "power-on", steps: [ON_STEP[id]!] } : null;
}

/** One `power-off` card for several conflicts (Turn off all). */
export function offAllSteps(ids: readonly string[]): number[] {
  return [...new Set(ids.filter((id) => id in OFF_STEP).map((id) => OFF_STEP[id]!))].sort((a, b) => a - b);
}

/** Conflicts the user may mark as handled: their control is a setting, not a service. */
export const ignorable = (id: string): boolean => id === "hhd" || id.startsWith("som-remote:");

export function conflictText(c: Pick<PowerConflict, "id" | "name"> & Partial<Pick<PowerConflict, "how">>): ConflictText {
  const t = TEXTS[c.id];
  if (t) return t;
  if (c.id.startsWith("som-remote:")) {
    return { name: c.name || "Steam's TDP slider", line: "Another remote lets Steam's TDP slider write the power limits.", body: ["A steamos-manager remote other than the hardware helper's writes the power limits for Steam's TDP slider. Remove the package that installed it, or choose \"I've handled it\" if you know it is harmless."] };
  }
  return { name: c.name || c.id, line: LIMITS, body: [c.how || "It changes the same settings as the hardware helper."] };
}

/** The conflicts that keep power control from turning on: they fight the limits, and the user did not mark them handled. */
export const blocking = (cs: readonly PowerConflict[] | undefined, ignored: readonly string[]): PowerConflict[] =>
  (cs ?? []).filter((c) => c.active && c.kind === "blocks" && !ignored.includes(c.id));

/** The active conflicts that take CPU energy policy (energy preference is left to them). */
export const cpuLockers = (cs: readonly PowerConflict[] | undefined): PowerConflict[] => (cs ?? []).filter((c) => c.active && c.kind === "cpu");

/** "Locked by Power Profiles and TuneD." */
export const lockedLine = (cs: readonly PowerConflict[]): string =>
  `Locked by ${cs.map((c) => conflictText(c).name).join(" and ") || "another program"}.`;

/** Records of conflicts the plugin saw stop after it showed their card (storage `conflicts`). */
export interface TurnedOff {
  /** Unix s when it was seen stopped. */
  at: number;
}

/**
 * The records after a new read: a conflict that was active in `before` and is not now gets one
 * (the user ran its card, or stopped it some other way).
 */
export function recordTurnedOff(
  before: readonly PowerConflict[] | undefined,
  after: readonly PowerConflict[],
  records: Record<string, TurnedOff>,
  at: number,
): Record<string, TurnedOff> {
  const out = { ...records };
  for (const b of before ?? []) {
    if (!b.active || out[b.id] || !(b.id in ON_STEP || b.id in OFF_STEP)) continue;
    const now = after.find((c) => c.id === b.id);
    if (!now || !now.active) out[b.id] = { at };
  }
  return out;
}

/** A recorded conflict that runs again ("It started again", original cameBackText). */
export const cameBack = (c: PowerConflict, records: Record<string, TurnedOff>): boolean => c.active && !!records[c.id];

export function cameBackText(id: string): string {
  if (id === "power-profiles-daemon" || id === "tuned" || id === "tuned-ppd") return "It started again, likely from the desktop's power mode or a game launcher.";
  if (id === "powerstation") return "It's back on, likely after a Bazzite update.";
  return "It started again.";
}
