// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The power profiles as `system.profiles` rules (pure; SPEC §5.3, §11.8). hostd applies them itself
 * when a game starts or stops, the charger changes, the battery falls below the low level or the
 * device wakes, also while this plugin is stopped.
 *
 * Precedence is hostd's: game and low battery, game and power source, game, low battery, power
 * source, the empty `when`. Knobs the winning rule leaves out go back to their defaults, so every
 * rule carries its whole profile, the "Run from charger" choice included. The low-battery rules also
 * name `power: "battery"`: hostd matches `batteryBelow` on the charger too (and ranks it above the
 * plugged-in rule), while the original ended the low values when plugged in (power.py _low_eval).
 */
import type { HardwareRule, HardwareRuleSet } from "@bathysphere/sdk";
import { BATTERY_LOW, CAP_FIELD, CORE_TYPES, EPP_FIELD, eppToEnergy, followOffset, mergeLow, type CoreType, type PowerData, type Values } from "./profiles";

const isCoreType = (t: string): t is CoreType => (CORE_TYPES as readonly string[]).includes(t);

/** What the device offers, from `system.hardware.get` and the knobs' gets. A missing knob: undefined. */
export interface RuleCaps {
  boost?: { modes: string[]; offsetMax: number };
  epp?: { types: string[]; available: string[] };
  energy?: { available: string[] };
  cpuLimits?: { types: string[] };
  socBalance?: { balance: number; offset: number };
  gpuRange?: { floorMhz: number; ceilMhz: number };
  fan?: { modes: string[] };
  chargeBehaviour?: { available: string[] };
  /** Steam's sustained power now (for the follow offset). */
  tdpW: number | null;
  /** "Run from charger" is on: copied into every rule. */
  runFromCharger: boolean;
}

export const MAX_RULES = 64;

type Power = "ac" | "battery";

/** The rule `set` of one slot's values. */
export function ruleSet(v: Values, power: Power, caps: RuleCaps): HardwareRuleSet {
  const set: HardwareRuleSet = {};
  if (caps.boost) {
    if (v.boostW !== null && caps.boost.modes.includes("manual")) set.boost = { mode: "manual", watts: v.boostW };
    else if (v.follow && caps.boost.modes.includes("follow") && caps.tdpW !== null) {
      set.boost = { mode: "follow", offsetW: followOffset(caps.tdpW, power === "ac", caps.boost.offsetMax) };
    }
  }
  if (caps.epp) {
    const types = caps.epp.types.filter((t) => t !== "all");
    const perType = v.eppP !== null || v.eppE !== null || v.eppLpe !== null;
    const ok = (x: string | null): x is string => x !== null && caps.epp!.available.includes(x);
    if (perType) {
      // never "all" together with per-type keys (hw1.xml SetEnergyPreference)
      const byType: Record<string, string> = {};
      for (const t of types) {
        const x = (isCoreType(t) ? v[EPP_FIELD[t]] : null) ?? v.epp;
        if (ok(x)) byType[t] = x;
      }
      if (Object.keys(byType).length) set.epp = byType;
    } else if (ok(v.epp)) {
      set.epp = caps.epp.types.includes("all") ? { all: v.epp } : Object.fromEntries(types.map((t) => [t, v.epp as string]));
    }
  } else if (caps.energy) {
    const e = v.energy ?? eppToEnergy(v.epp);
    if (e !== null && caps.energy.available.includes(e)) set.energy = e;
  }
  if (caps.cpuLimits) {
    const c: NonNullable<HardwareRuleSet["cpuLimits"]> = {};
    const mhz: Record<string, number> = {};
    for (const t of caps.cpuLimits.types) {
      const cap = isCoreType(t) ? v[CAP_FIELD[t]] : null;
      if (cap !== null) mhz[t] = cap;
    }
    if (Object.keys(mhz).length) c.coreTypeMaxMhz = mhz;
    else if (v.cpuMaxPct !== null) c.maxPerfPct = v.cpuMaxPct;
    // the minimum speed only plugged in (the provider refuses it on battery), at most min(50, cap)
    if (power === "ac" && v.cpuMinPct !== null) c.minPerfPct = Math.min(v.cpuMinPct, 50, v.cpuMaxPct ?? 100);
    if (Object.keys(c).length) set.cpuLimits = c;
  }
  if (caps.socBalance && (v.socBalance !== null || v.socOffset !== null)) {
    set.socBalance = { balance: v.socBalance ?? caps.socBalance.balance, offset: v.socOffset ?? caps.socBalance.offset };
  }
  if (caps.gpuRange && (v.gpuMinMhz !== null || v.gpuMaxMhz !== null)) {
    set.gpuRange = { minMhz: v.gpuMinMhz ?? caps.gpuRange.floorMhz, maxMhz: v.gpuMaxMhz ?? caps.gpuRange.ceilMhz };
  }
  if (caps.fan && v.fan !== null && caps.fan.modes.includes(v.fan)) set.fan = v.fan;
  if (caps.runFromCharger && caps.chargeBehaviour?.available.includes("inhibit-charge-awake")) set.chargeBehaviour = "inhibit-charge-awake";
  return set;
}

/**
 * A rule's set must name a knob, but a profile may set none ("all device defaults"). Such a rule
 * still has to win over a less specific one, so it sets the fan to its default (Auto), which
 * changes nothing and lets every other knob go back to its default; without a fan, boost "firmware".
 */
function placeholder(caps: RuleCaps): HardwareRuleSet | null {
  if (caps.fan?.modes.includes("auto")) return { fan: "auto" };
  if (caps.boost?.modes.includes("firmware")) return { boost: { mode: "firmware" } };
  return null;
}

/** The slot needs its own plugged-in rule: the follow offset and the minimum speed differ there. */
const needsAc = (v: Values): boolean => v.follow === true || v.cpuMinPct !== null;

export interface BuiltRules {
  rules: HardwareRule[];
  /** Game profiles left out because the rules ran out (newest profiles go first). */
  left: string[];
}

export function buildRules(data: PowerData, caps: RuleCaps): BuiltRules {
  const { options: o } = data;
  const def = data.profiles.default!;
  const out: HardwareRule[] = [];
  const add = (id: string, when: HardwareRule["when"], v: Values, power: Power, always: boolean): void => {
    let set = ruleSet(v, power, caps);
    if (Object.keys(set).length === 0) {
      if (!always) return;
      const p = placeholder(caps);
      if (!p) return;
      set = p;
    }
    out.push({ id, when, set });
  };
  const lowValues = def.low ?? BATTERY_LOW;
  add("default", {}, def.main, "battery", false);
  const defAc = o.splitAc ? (def.ac ?? def.main) : def.main;
  if (o.splitAc || needsAc(def.main)) add("ac", { power: "ac" }, defAc, "ac", true);
  if (o.lowBattery) add("low", { power: "battery", batteryBelow: o.lowPct }, mergeLow(def.main, lowValues, caps.tdpW), "battery", true);

  const left: string[] = [];
  if (o.perGame) {
    const games = Object.entries(data.profiles)
      .filter(([k]) => k !== "default")
      .sort((a, b) => b[1].at - a[1].at);
    for (const [key, p] of games) {
      const app = Number(key);
      const acV = o.splitAc ? (p.ac ?? p.main) : p.main;
      const wantAc = o.splitAc || needsAc(p.main);
      const wantLow = o.lowBattery && o.lowGames;
      const n = 1 + (wantAc ? 1 : 0) + (wantLow ? 1 : 0);
      if (out.length + n > MAX_RULES) {
        left.push(key);
        continue;
      }
      add(`app-${key}`, { app }, p.main, "battery", true);
      if (wantAc) add(`app-${key}-ac`, { app, power: "ac" }, acV, "ac", true);
      if (wantLow) add(`app-${key}-low`, { app, power: "battery", batteryBelow: o.lowPct }, mergeLow(p.main, lowValues, caps.tdpW), "battery", true);
    }
  }
  return { rules: out, left };
}

/** Two rule lists equal for "are hostd's rules ours?" (the follow offset depends on the sustained power then). */
export function sameRules(a: readonly HardwareRule[], b: readonly HardwareRule[]): boolean {
  const norm = (rs: readonly HardwareRule[]) =>
    JSON.stringify(
      rs.map((r) => {
        const set = { ...r.set };
        if (set.boost?.mode === "follow") set.boost = { mode: "follow" };
        return { id: r.id, when: r.when, set };
      }),
    );
  return norm(a) === norm(b);
}

/** Which profile and slot a rule id stands for ("app-570-ac" → 570, ac). */
export function ruleTarget(id: string | null | undefined): { key: string; slot: "main" | "ac" | "low" } | null {
  if (!id) return null;
  if (id === "default") return { key: "default", slot: "main" };
  if (id === "ac") return { key: "default", slot: "ac" };
  if (id === "low") return { key: "default", slot: "low" };
  const m = /^app-(\d+)(?:-(ac|low))?$/.exec(id);
  return m ? { key: m[1]!, slot: (m[2] as "ac" | "low" | undefined) ?? "main" } : null;
}
