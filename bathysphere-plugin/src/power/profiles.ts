// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The power profiles (pure): what the user set per profile and slot, normalised the way power.py
 * normalised power.json, the one-tap presets (src/power.ts) and the low-battery merge (power.py
 * _merge_low). A profile holds only the knobs hostd applies by rules (SPEC §11.8: boost, energy
 * preference or energy mode, CPU limits, SoC balance, GPU range, fan); Steam's own knobs (sustained
 * power, CPU boost, GPU power saving) are set directly and are not per profile.
 */
import { bool, int, isAppidKey, isObj, text, word, type Obj } from "../core/storage";

/** One slot's values; null leaves the knob at the device default. */
export interface Values {
  /** Boost (PL2) in W, manual. */
  boostW: number | null;
  /** "Steadier fps after loads": boost follows sustained power (+25 %, +50 % plugged in). */
  follow: boolean | null;
  /** Energy preference of every core, and per core type (wins over `epp` for that type). */
  epp: string | null;
  eppP: string | null;
  eppE: string | null;
  eppLpe: string | null;
  /** power-profiles-daemon's mode, used instead of `epp` while it owns EPP. */
  energy: string | null;
  cpuMaxPct: number | null;
  /** Plugged in only (the provider refuses it on battery). */
  cpuMinPct: number | null;
  capP: number | null;
  capE: number | null;
  capLpe: number | null;
  socBalance: number | null;
  socOffset: number | null;
  gpuMinMhz: number | null;
  gpuMaxMhz: number | null;
  fan: string | null;
}

export const EMPTY: Values = {
  boostW: null, follow: null, epp: null, eppP: null, eppE: null, eppLpe: null, energy: null, cpuMaxPct: null, cpuMinPct: null,
  capP: null, capE: null, capLpe: null, socBalance: null, socOffset: null, gpuMinMhz: null, gpuMaxMhz: null, fan: null,
};

export const FIELDS = Object.keys(EMPTY) as Array<keyof Values>;
export const CORE_TYPES = ["p", "e", "lpe"] as const;
export type CoreType = (typeof CORE_TYPES)[number];
export const CAP_FIELD = { p: "capP", e: "capE", lpe: "capLpe" } as const;
export const EPP_FIELD = { p: "eppP", e: "eppE", lpe: "eppLpe" } as const;
export const CORE_NAME: Record<CoreType, string> = { p: "Performance cores", e: "Efficient cores", lpe: "Low-power cores" };

export type Slot = "main" | "ac" | "low";

export interface Profile {
  /** The game's name (null for Default). */
  name: string | null;
  main: Values;
  /** Plugged-in values when "Different settings when plugged in" is on; null: the same as main. */
  ac: Values | null;
  /** Default only: the low-battery values; null: the Battery preset's. */
  low: Values | null;
  /** When the profile was made (Unix s): the newest game profiles go first when rules run out. */
  at: number;
}

export interface PowerOptions {
  perGame: boolean;
  splitAc: boolean;
  lowBattery: boolean;
  /** 10–40 % (the slider); hostd takes 5–50. */
  lowPct: number;
  lowGames: boolean;
}

export interface PowerData {
  enabled: boolean;
  options: PowerOptions;
  /** Conflicts the user handled ("I've handled it"). */
  ignored: string[];
  profiles: Record<string, Profile>;
}

export const OPTION_DEFAULTS: PowerOptions = { perGame: true, splitAc: false, lowBattery: true, lowPct: 20, lowGames: false };
export const LOW_SLIDER = { min: 10, max: 40, step: 5 } as const;
/** At most this many game profiles are kept (rules run out long before). */
export const MAX_PROFILES = 100;

const intOrNull = (v: unknown, lo: number, hi: number) => int(v, lo, hi);

/** One slot as stored, bad fields null (power.py _norm_values). */
export function normValues(raw: unknown): Values {
  const r: Obj = isObj(raw) ? raw : {};
  const v: Values = {
    boostW: intOrNull(r.boostW, 3, 60),
    follow: typeof r.follow === "boolean" ? r.follow : null,
    epp: word(r.epp),
    eppP: word(r.eppP),
    eppE: word(r.eppE),
    eppLpe: word(r.eppLpe),
    energy: word(r.energy),
    cpuMaxPct: intOrNull(r.cpuMaxPct, 30, 100),
    cpuMinPct: intOrNull(r.cpuMinPct, 1, 50),
    capP: intOrNull(r.capP, 100, 8000),
    capE: intOrNull(r.capE, 100, 8000),
    capLpe: intOrNull(r.capLpe, 100, 8000),
    socBalance: intOrNull(r.socBalance, 0, 16),
    socOffset: intOrNull(r.socOffset, 0, 16),
    gpuMinMhz: intOrNull(r.gpuMinMhz, 0, 5000),
    gpuMaxMhz: intOrNull(r.gpuMaxMhz, 0, 5000),
    fan: word(r.fan),
  };
  // power.py EXCLUSIVE: the CPU speed cap or the per-core caps, not both
  if (v.cpuMaxPct !== null && (v.capP !== null || v.capE !== null || v.capLpe !== null)) {
    v.capP = v.capE = v.capLpe = null;
  }
  return v;
}

function normProfile(raw: unknown, key: string): Profile {
  const r: Obj = isObj(raw) ? raw : {};
  return {
    name: key === "default" ? null : text(r.name, 128),
    main: normValues(r.main),
    ac: isObj(r.ac) ? normValues(r.ac) : null,
    low: key === "default" && isObj(r.low) ? normValues(r.low) : null,
    at: int(r.at, 0, 2 ** 40) ?? 0,
  };
}

/** The stored power data (power.py _norm_data). */
export function normPower(raw: Obj): PowerData {
  const o: Obj = isObj(raw.options) ? raw.options : {};
  const pct = int(o.lowPct, LOW_SLIDER.min, LOW_SLIDER.max);
  const profiles: Record<string, Profile> = { default: normProfile(isObj(raw.profiles) ? raw.profiles.default : null, "default") };
  if (isObj(raw.profiles)) {
    const games = Object.entries(raw.profiles)
      .filter(([k]) => isAppidKey(k))
      .map(([k, p]) => [k, normProfile(p, k)] as const)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_PROFILES);
    for (const [k, p] of games) profiles[k] = p;
  }
  return {
    enabled: raw.enabled === true,
    options: {
      perGame: bool(o.perGame, OPTION_DEFAULTS.perGame),
      splitAc: bool(o.splitAc, OPTION_DEFAULTS.splitAc),
      lowBattery: bool(o.lowBattery, OPTION_DEFAULTS.lowBattery),
      lowPct: pct !== null && pct % LOW_SLIDER.step === 0 ? pct : OPTION_DEFAULTS.lowPct,
      lowGames: bool(o.lowGames, OPTION_DEFAULTS.lowGames),
    },
    ignored: Array.isArray(raw.ignored) ? [...new Set(raw.ignored.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9:._-]{1,80}$/.test(x)))] : [],
    profiles,
  };
}

/** A copy of `v` with `change` merged in (null clears a field). */
export const withValues = (v: Values, change: Partial<Values>): Values => normValues({ ...v, ...change });

/** The slot's stored values (an AC slot falls back to main). */
export function slotValues(p: Profile, slot: Slot): Values {
  if (slot === "ac") return p.ac ?? p.main;
  if (slot === "low") return p.low ?? BATTERY_LOW;
  return p.main;
}

export const usesCaps = (v: Values): boolean => v.capP !== null || v.capE !== null || v.capLpe !== null;

// ---- boost follows sustained (power.py PL2_FOLLOW) -------------------------------------------------

/** Boost = sustained × 1.25 on battery, × 1.5 plugged in: as a fixed offset above sustained (Hw1 "follow"). */
export const FOLLOW_SHARE = { battery: 0.25, ac: 0.5 } as const;

export function followOffset(tdpW: number, ac: boolean, offsetMax: number): number {
  return Math.max(0, Math.min(offsetMax, Math.round(tdpW * FOLLOW_SHARE[ac ? "ac" : "battery"])));
}

// ---- presets (src/power.ts) ------------------------------------------------------------------------

export type PresetId = "battery" | "balanced" | "performance" | "max";
export const PRESET_IDS: PresetId[] = ["battery", "balanced", "performance", "max"];
export const PRESET_LABEL: Record<PresetId, string> = { battery: "Battery", balanced: "Balanced", performance: "Performance", max: "Max" };

/**
 * OEM presets 5/17/35 W and the firmware's 25 W, as the original's provisional table. `tdp` and
 * `boostW` "max" are the device's top; boost null leaves it to the firmware; cpuBoost and
 * gpuSaving null leave Steam's setting as it is.
 */
export interface PresetRow {
  tdp: number | "max";
  boostW: number | "max" | null;
  epp: string;
  cpuBoost: boolean | null;
  gpuSaving: boolean | null;
}
export const PRESETS: Record<PresetId, PresetRow> = {
  battery: { tdp: 10, boostW: 15, epp: "balance_power", cpuBoost: false, gpuSaving: true },
  balanced: { tdp: 17, boostW: 25, epp: "balance_performance", cpuBoost: null, gpuSaving: null },
  performance: { tdp: 28, boostW: null, epp: "balance_performance", cpuBoost: null, gpuSaving: null },
  max: { tdp: "max", boostW: "max", epp: "performance", cpuBoost: true, gpuSaving: false },
};

/** The low-battery values while none are stored: the Battery preset's rule part (power.py BATTERY_PRESET). */
export const BATTERY_LOW: Values = { ...EMPTY, boostW: 15, epp: "balance_power" };

/** power-profiles-daemon's modes for an energy preference (used while it owns EPP). */
export function eppToEnergy(epp: string | null): string | null {
  if (epp === null) return null;
  if (epp === "performance") return "performance";
  if (epp === "balance_performance" || epp === "default") return "balanced";
  return "power-saver";
}

export interface PresetRanges {
  tdpMin: number;
  tdpMax: number;
  boostMin: number;
  boostMax: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, hi), Math.max(lo, Math.round(v)));

/** A preset's numbers inside this device's ranges: sustained W, and boost W (never below sustained). */
export function presetNumbers(id: PresetId, r: PresetRanges): { tdp: number; boostW: number | null } {
  const row = PRESETS[id];
  const tdp = clamp(row.tdp === "max" ? r.tdpMax : row.tdp, Math.ceil(r.tdpMin), Math.floor(r.tdpMax));
  const boostW = row.boostW === null ? null : clamp(row.boostW === "max" ? r.boostMax : row.boostW, Math.max(tdp, r.boostMin), Math.floor(r.boostMax));
  return { tdp, boostW };
}

/** The preset the slot and Steam's sustained power match, else custom (or default when nothing is set). */
export function presetOf(v: Values, tdpW: number | null, r: PresetRanges, eppOk: boolean): PresetId | "custom" | "default" {
  for (const id of PRESET_IDS) {
    const n = presetNumbers(id, r);
    const epp = PRESETS[id].epp;
    const eppMatch = !eppOk || (v.epp === epp && v.eppP === null && v.eppE === null && v.eppLpe === null) || (v.epp === null && v.energy === eppToEnergy(epp));
    if (tdpW === n.tdp && v.boostW === n.boostW && (n.boostW !== null || v.follow !== true) && eppMatch) return id;
  }
  return v.boostW === null && v.epp === null && v.energy === null && !v.follow ? "default" : "custom";
}

// ---- low battery (power.py _merge_low) ------------------------------------------------------------

/**
 * The low slot over a profile's own values, never raising a limit: boost, the CPU speed cap and the
 * GPU maximum are the lower of the two; every other field is the low slot's when it sets one. A
 * following boost counts as what it gives on battery at `tdpW`. A low energy preference replaces
 * the profile's per-type ones.
 */
export function mergeLow(normal: Values, low: Values, tdpW: number | null): Values {
  const out: Values = { ...normal };
  for (const f of FIELDS) {
    if (f === "boostW" || f === "follow" || f === "cpuMaxPct" || f === "gpuMaxMhz") continue;
    if (low[f] !== null) (out as unknown as Record<string, unknown>)[f] = low[f];
  }
  for (const f of ["cpuMaxPct", "gpuMaxMhz"] as const) {
    const l = low[f];
    if (l !== null) out[f] = normal[f] === null ? l : Math.min(normal[f]!, l);
  }
  const eff = (v: Values): number | null =>
    v.boostW ?? (v.follow && tdpW !== null ? tdpW + followOffset(tdpW, false, Infinity) : null);
  const nEff = eff(normal);
  const lEff = eff(low);
  if (lEff !== null && (nEff === null || lEff <= nEff)) {
    out.boostW = low.boostW;
    out.follow = low.boostW === null ? true : null;
  }
  if (low.epp !== null && low.eppP === null && low.eppE === null && low.eppLpe === null) out.eppP = out.eppE = out.eppLpe = null;
  return normValues(out);
}
