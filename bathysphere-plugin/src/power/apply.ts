// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Power control: the stored profiles, writing them as hostd rules, turning power control on and
 * off, the other power programs, and Take control. Every write happens from a handler of an open
 * surface (SPEC §5.3 open-surface rule), and only on an ONEXPLAYER 3.
 */
import { host, LEASED_KNOBS, type HardwareKnob, type HardwareProfiles, type LeasedKnob, type PowerConflict } from "@bathysphere/sdk";
import { Cached } from "../core/cache";
import { nowSeconds } from "../core/clock";
import { explain, type Explained } from "../core/errors";
import { hwWrite, type Outcome } from "../core/queue";
import { debounce, redraw } from "../core/redraw";
import { isObj, Stored, type Obj } from "../core/storage";
import { onOxp3 } from "../device/info";
import { hw, type HwSnapshot } from "../hw/knobs";
import { write as steamWrite, written } from "../hw/steam";
import { prefs } from "../ui/prefs";
import { blocking, recordTurnedOff, type TurnedOff } from "./conflicts";
import { EMPTY, MAX_PROFILES, normPower, withValues, type PowerData, type PowerOptions, type Slot, type Values } from "./profiles";
import { buildRules, ruleTarget, sameRules, type BuiltRules, type RuleCaps } from "./rules";

export const power = new Stored<PowerData>("power", "Power profiles", 1, normPower);

/** hostd's stored rules and the rule that won last (SPEC §5.3 system.profiles.get). */
export const profiles = new Cached<HardwareProfiles>(() => host.system.profiles.get(), 2000);

/** The other power programs, at most every 60 s while a surface shows them (and on Check again). */
export const conflicts = new Cached<PowerConflict[]>(() => host.system.power.conflicts(), 60_000);

function normRecords(raw: Obj): { off: Record<string, TurnedOff> } {
  const off: Record<string, TurnedOff> = {};
  if (isObj(raw.off)) {
    for (const [id, r] of Object.entries(raw.off)) {
      if (/^[A-Za-z0-9:._-]{1,80}$/.test(id) && isObj(r) && typeof r.at === "number") off[id] = { at: r.at };
    }
  }
  return { off };
}

/** Programs the plugin saw stop after showing their card (storage `conflicts`). */
export const turnedOff = new Stored("conflicts", "Turned-off power programs", 1, normRecords);

/** The last rules written and their outcome. */
export let lastRules: BuiltRules | null = null;
export let rulesError: Explained | null = null;
/** Conflicts that refused the last "turn on". */
export let refused: PowerConflict[] = [];
/** The last "turn on" was refused because the other power programs could not be read (never assumed absent). */
export let unchecked: Explained | null = null;

const RULES_DEBOUNCE_MS = 1000;

/** Reads the conflicts (again with `force`) and records the ones that stopped since the last read. */
export async function readConflicts(force = false): Promise<void> {
  if (!onOxp3()) return;
  const before = conflicts.value;
  if (force) conflicts.invalidate();
  await conflicts.load();
  if (!conflicts.error) unchecked = null;
  if (!conflicts.value || conflicts.value === before) return;
  const next = recordTurnedOff(before, conflicts.value, turnedOff.value.off, nowSeconds());
  if (Object.keys(next).length !== Object.keys(turnedOff.value.off).length) await turnedOff.save({ off: next });
  refused = refused.filter((c) => conflicts.value!.some((x) => x.id === c.id && x.active));
}

export async function forgetTurnedOff(id: string): Promise<void> {
  const off = { ...turnedOff.value.off };
  delete off[id];
  await turnedOff.save({ off });
}

/** What the device offers for rules, from the hardware snapshot. */
export function ruleCaps(s: HwSnapshot): RuleCaps {
  const caps: RuleCaps = { tdpW: s.tdp.value?.watts ?? null, runFromCharger: s.chargeBehaviour.value?.value === "inhibit-charge-awake" };
  if (s.boost.value) caps.boost = { modes: s.boost.value.modes, offsetMax: s.boost.value.offsetMax };
  if (s.epp.value) caps.epp = { types: s.epp.value.types, available: s.epp.value.available };
  if (s.energy.value) caps.energy = { available: s.energy.value.available };
  if (s.cpuLimits.value) caps.cpuLimits = { types: Object.keys(s.cpuLimits.value.coreTypeRange) };
  if (s.socBalance.value) caps.socBalance = { balance: s.socBalance.value.balance, offset: s.socBalance.value.offset };
  if (s.gpuRange.value) caps.gpuRange = { floorMhz: s.gpuRange.value.floorMhz, ceilMhz: s.gpuRange.value.ceilMhz };
  if (s.fan.value) caps.fan = { modes: s.fan.value.modes };
  if (s.chargeBehaviour.value) caps.chargeBehaviour = { available: s.chargeBehaviour.value.available };
  return caps;
}

/** The rules the stored profiles give now, or null before the hardware was read. */
export function wantedRules(): BuiltRules | null {
  return hw.value ? buildRules(power.value, ruleCaps(hw.value)) : null;
}

/** hostd's rules differ from the stored profiles (after a reinstall, or a write that failed). */
export function rulesOutOfDate(): boolean {
  const want = wantedRules();
  const have = profiles.value?.rules;
  if (!want || !have) return false;
  return power.value.enabled ? !sameRules(want.rules, have) : have.length > 0;
}

/** Writes the rules now (the queue keeps profiles.set at 1/s; a newer write replaces a waiting one). */
export async function writeRules(): Promise<Outcome | null> {
  if (!onOxp3() || !power.value.enabled) return null;
  hw.invalidate();
  await hw.load();
  if (!hw.value) return null;
  const built = buildRules(power.value, ruleCaps(hw.value));
  lastRules = built;
  const o = await hwWrite("rules", "system.profiles.set", () => host.system.profiles.set(built.rules));
  rulesError = o.ok ? null : explain(o.error);
  profiles.invalidate();
  hw.invalidate();
  await profiles.load();
  redraw();
  return o;
}

/** A profile edit: stored at once, written as rules 1 s after the last edit. */
export function scheduleRules(): void {
  debounce("rules", RULES_DEBOUNCE_MS, () => void writeRules());
}

/**
 * The profile and slot the active rule stands for (what the quick sliders edit). A game's
 * low-battery rule is made from Default's low values, so those are what it edits (quickgroups.ts
 * editedSlot).
 */
export function activeTarget(): { key: string; slot: Slot } {
  const t = ruleTarget(profiles.value?.active.rule);
  if (t?.slot === "low") return { key: "default", slot: "low" };
  if (!t || !power.value.profiles[t.key]) return { key: "default", slot: "main" };
  if (t.slot === "ac" && !power.value.options.splitAc) return { key: t.key, slot: "main" };
  return t;
}

/** Changes one slot of a profile (creating a game profile when needed) and schedules the rules. */
export async function editSlot(key: string, slot: Slot, change: Partial<Values>): Promise<void> {
  const data = structuredClone(power.value);
  const p = data.profiles[key];
  if (!p) return;
  if (slot === "low") p.low = withValues(p.low ?? data.profiles.default!.low ?? EMPTY, change);
  else if (slot === "ac") p.ac = withValues(p.ac ?? p.main, change);
  else p.main = withValues(p.main, change);
  await power.save(data);
  scheduleRules();
}

/** Clears every knob of a slot ("Reset to device defaults"). */
export async function resetSlot(key: string, slot: Slot): Promise<void> {
  const data = structuredClone(power.value);
  const p = data.profiles[key];
  if (!p) return;
  if (slot === "low") p.low = null;
  else if (slot === "ac") p.ac = { ...EMPTY };
  else p.main = { ...EMPTY, fan: p.main.fan };
  await power.save(data);
  scheduleRules();
}

export async function setOptions(change: Partial<PowerOptions>): Promise<void> {
  const data = structuredClone(power.value);
  data.options = { ...data.options, ...change };
  await power.save(data);
  scheduleRules();
}

/** A game's own profile (a copy of Default), or none. */
export async function setGameProfile(appid: number, name: string, on: boolean): Promise<void> {
  const data = structuredClone(power.value);
  const key = String(appid);
  if (on) {
    const def = data.profiles.default!;
    data.profiles[key] = { name, main: { ...def.main }, ac: def.ac ? { ...def.ac } : null, low: null, at: nowSeconds() };
    const games = Object.keys(data.profiles).filter((k) => k !== "default");
    if (games.length > MAX_PROFILES) {
      const oldest = games.sort((a, b) => data.profiles[a]!.at - data.profiles[b]!.at)[0]!;
      delete data.profiles[oldest];
    }
  } else delete data.profiles[key];
  await power.save(data);
  scheduleRules();
}

export async function setIgnored(id: string, on: boolean): Promise<void> {
  const data = structuredClone(power.value);
  data.ignored = on ? [...new Set([...data.ignored, id])] : data.ignored.filter((x) => x !== id);
  await power.save(data);
}

/**
 * Power control on: refused while another program fights the limits, and while they cannot be read;
 * the first time asks once.
 * Off: hostd's rules cleared and every lease released, so the provider writes each knob's default
 * (its compiled default or the boot snapshot); Run from charger is set again when it was on.
 */
export async function setEnabled(on: boolean): Promise<void> {
  if (!onOxp3()) return;
  if (on) {
    await readConflicts(true);
    unchecked = conflicts.error ? explain(conflicts.error) : null;
    if (unchecked) return;
    refused = blocking(conflicts.value, power.value.ignored);
    if (refused.length) return;
    if (!prefs.value.powerConfirmed) {
      const ok = await host.ui.confirm({
        title: "Turn on power control?",
        body: "OXP3 Deck then sets boost power, energy preference, CPU limits, the CPU vs GPU balance, the GPU speed range and the fan through the ONEXPLAYER 3 hardware helper, per profile, also while OXP3 Deck is closed. Values outside the device's safe range are refused.\n\nTurning it off writes the device's defaults back. Sustained power stays Steam's (Quick Access → Performance).",
        ok: "Turn on",
      });
      if (!ok) return;
      await prefs.save({ ...prefs.value, powerConfirmed: true });
    }
    await power.save({ ...power.value, enabled: true });
    await writeRules();
    return;
  }
  await power.save({ ...power.value, enabled: false });
  const rfc = hw.value?.chargeBehaviour.value?.value === "inhibit-charge-awake";
  const cleared = await hwWrite("rules", "system.profiles.clear", () => host.system.profiles.clear());
  rulesError = cleared.ok ? null : explain(cleared.error);
  const knobs: LeasedKnob[] = LEASED_KNOBS.filter((k) => !(rfc && k === "chargeBehaviour"));
  const released = await hwWrite("release", "system.hardware.release", () => host.system.hardware.release(knobs));
  if (!released.ok) rulesError = explain(released.error);
  if (rfc) await steamWrite("chargeBehaviour", "system.chargeBehaviour.set", () => host.system.chargeBehaviour.set("inhibit-charge-awake"));
  profiles.invalidate();
  hw.invalidate();
  redraw();
}

/**
 * Take control again after another program changed a knob: the knob's own set with the value the
 * active rule (or the user) wants, which the provider takes as the lease holder's new set and stops
 * calling the knob overridden (hw1.xml). Home's Hardware page has the real Take control.
 */
export async function takeControl(knob: HardwareKnob): Promise<void> {
  await hw.load();
  const s = hw.value;
  if (!s) return;
  const active = profiles.value?.active.rule;
  const rule = (profiles.value?.rules ?? []).find((r) => r.id === active)?.set ?? {};
  const run = (method: string, fn: () => Promise<unknown>) => steamWrite(knob, method, fn);
  switch (knob) {
    case "tdp": {
      const w = written.get("tdp") ?? s.tdp.value?.watts;
      if (typeof w === "number") await steamWrite(knob, "system.tdp.set", () => host.system.tdp.set(w), w);
      break;
    }
    case "boost": {
      const b = rule.boost ?? (s.boost.value ? { mode: s.boost.value.mode, ...(s.boost.value.mode === "manual" ? { watts: s.boost.value.watts } : s.boost.value.mode === "follow" ? { offsetW: s.boost.value.offsetW } : {}) } : null);
      if (b) await run("system.boost.set", () => host.system.boost.set(b));
      break;
    }
    case "fan": {
      const m = rule.fan ?? s.fan.value?.mode;
      if (m) await run("system.fan.set", () => host.system.fan.set(m));
      break;
    }
    case "epp": {
      const e = rule.epp ?? s.epp.value?.byType;
      if (e) await run("system.epp.set", () => host.system.epp.set(e));
      break;
    }
    case "energy": {
      const e = rule.energy ?? s.energy.value?.profile;
      if (e) await run("system.energy.set", () => host.system.energy.set(e));
      break;
    }
    case "cpuLimits": {
      const c = rule.cpuLimits ?? (s.cpuLimits.value ? { maxPerfPct: s.cpuLimits.value.maxPerfPct } : null);
      if (c) await run("system.cpuLimits.set", () => host.system.cpuLimits.set(c));
      break;
    }
    case "socBalance": {
      const b = rule.socBalance ?? (s.socBalance.value ? { balance: s.socBalance.value.balance, offset: s.socBalance.value.offset } : null);
      if (b) await run("system.socBalance.set", () => host.system.socBalance.set(b));
      break;
    }
    case "gpuRange": {
      const r = rule.gpuRange ?? (s.gpuRange.value ? { minMhz: s.gpuRange.value.minMhz, maxMhz: s.gpuRange.value.maxMhz } : null);
      if (r) await run("system.gpu.range.set", () => host.system.gpu.range.set(r));
      break;
    }
    case "chargeLimit": {
      const p = written.get("chargeLimit") ?? s.chargeLimit.value?.percent;
      if (typeof p === "number") await steamWrite(knob, "system.chargeLimit.set", () => host.system.chargeLimit.set(p), p);
      break;
    }
    case "chargeBehaviour": {
      const b = written.get("chargeBehaviour") ?? s.chargeBehaviour.value?.value;
      if (typeof b === "string") await steamWrite(knob, "system.chargeBehaviour.set", () => host.system.chargeBehaviour.set(b), b);
      break;
    }
    default:
      break;
  }
}
