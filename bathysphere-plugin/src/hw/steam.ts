// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Writes of the knobs Steam owns (SPEC §11.2: sustained power, GPU power profile, CPU boost, charge
 * limit), the charge behaviour, and the fan while power control is off, set directly from an open
 * surface. Steam's have no lease and are not per profile; the last writer wins and hostd never
 * re-asserts them (§4). Each control's last outcome is kept for the row under it.
 */
import { host } from "@bathysphere/sdk";
import { explain, type Explained } from "../core/errors";
import { hwWrite, type Outcome } from "../core/queue";
import { debounce, redraw } from "../core/redraw";
import { hw } from "./knobs";

/** The last failed write per control key ("tdp", "chargeLimit", …); cleared by a good one. */
export const writeErrors = new Map<string, Explained>();

/** Values a slider moved to but not yet written, so the row shows the user's value meanwhile. */
export const drafts = new Map<string, number>();

/** The last value OXP3 Deck wrote per Steam knob: another value later means someone else wrote it. */
export const written = new Map<string, number | string | boolean>();

async function record(key: string, o: Outcome, value: number | string | boolean | undefined): Promise<Outcome> {
  if (o.ok) {
    writeErrors.delete(key);
    if (value !== undefined) written.set(key, value);
  } else writeErrors.set(key, explain(o.error));
  drafts.delete(key);
  hw.invalidate();
  redraw();
  return o;
}

export const write = async (key: string, method: string, run: () => Promise<unknown>, value?: number | string | boolean): Promise<Outcome> =>
  record(key, await hwWrite(key, method, run), value);

/** A slider: written 400 ms after the last move (original useSettled). */
export function settle(key: string, value: number, method: string, run: (v: number) => Promise<unknown>): void {
  drafts.set(key, value);
  debounce(`steam:${key}`, 400, () => void write(key, method, () => run(value), value));
}

export const setTdp = (watts: number): void => settle("tdp", watts, "system.tdp.set", (w) => host.system.tdp.set(w));
export const setTdpNow = (watts: number): Promise<Outcome> => write("tdp", "system.tdp.set", () => host.system.tdp.set(watts), watts);
export const setCpuBoost = (on: boolean): Promise<Outcome> => write("cpuBoost", "system.cpuBoost.set", () => host.system.cpuBoost.set(on), on);
export const setGpuProfile = (profile: string): Promise<Outcome> =>
  write("gpuPowerProfile", "system.gpu.powerProfile.set", () => host.system.gpu.powerProfile.set(profile), profile);
/** The charge limit: 400 ms after the last move, then at most 1 per 10 s (the queue holds the newest). */
export const setChargeLimit = (percent: number): void =>
  settle("chargeLimit", percent, "system.chargeLimit.set", (p) => host.system.chargeLimit.set(p));
/** The fan now, while no profile rule sets it (power control off). Turning power control off releases its lease again. */
export const setFan = (mode: string): Promise<Outcome> => write("fan", "system.fan.set", () => host.system.fan.set(mode), mode);
export const setChargeBehaviour = (value: string): Promise<Outcome> =>
  write("chargeBehaviour", "system.chargeBehaviour.set", () => host.system.chargeBehaviour.set(value), value);
