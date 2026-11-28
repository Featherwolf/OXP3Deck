// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * What the hardware looks like now: `system.hardware.get` (backends, owners, leases, overrides) plus
 * the `get` of every knob it says is available (SPEC §5.3, §11.2). One unavailable or failing knob
 * never hides the others. Read only on an ONEXPLAYER 3, at most every 2 s while a surface shows it,
 * and again at once when `hardware.changed` names a knob.
 */
import {
  host,
  type BoostInfo,
  type ChargeBehaviourInfo,
  type ChargeLimitInfo,
  type CpuBoostInfo,
  type CpuLimitsInfo,
  type EnergyInfo,
  type EppInfo,
  type FanInfo,
  type GovernorInfo,
  type GpuPowerProfileInfo,
  type GpuRangeInfo,
  type HardwareChangeReason,
  type HardwareKnob,
  type HardwareState,
  type HostError,
  type KnobStatus,
  type SocBalanceInfo,
  type TdpInfo,
} from "@bathysphere/sdk";
import { Cached } from "../core/cache";
import { now } from "../core/clock";
import { asHostError } from "../core/errors";

export interface Read<T> {
  value?: T;
  error?: HostError;
}

export interface HwSnapshot {
  state: HardwareState;
  tdp: Read<TdpInfo>;
  gpuPowerProfile: Read<GpuPowerProfileInfo>;
  cpuBoost: Read<CpuBoostInfo>;
  governor: Read<GovernorInfo>;
  energy: Read<EnergyInfo>;
  boost: Read<BoostInfo>;
  epp: Read<EppInfo>;
  cpuLimits: Read<CpuLimitsInfo>;
  socBalance: Read<SocBalanceInfo>;
  gpuRange: Read<GpuRangeInfo>;
  fan: Read<FanInfo>;
  chargeLimit: Read<ChargeLimitInfo>;
  chargeBehaviour: Read<ChargeBehaviourInfo>;
}

export type ReadKnob = Exclude<keyof HwSnapshot, "state">;

const GETTERS: { [K in ReadKnob]: () => Promise<NonNullable<HwSnapshot[K]["value"]>> } = {
  tdp: () => host.system.tdp.get(),
  gpuPowerProfile: () => host.system.gpu.powerProfile.get(),
  cpuBoost: () => host.system.cpuBoost.get(),
  governor: () => host.system.cpuGovernor.get(),
  energy: () => host.system.energy.get(),
  boost: () => host.system.boost.get(),
  epp: () => host.system.epp.get(),
  cpuLimits: () => host.system.cpuLimits.get(),
  socBalance: () => host.system.socBalance.get(),
  gpuRange: () => host.system.gpu.range.get(),
  fan: () => host.system.fan.get(),
  chargeLimit: () => host.system.chargeLimit.get(),
  chargeBehaviour: () => host.system.chargeBehaviour.get(),
};

async function readAll(): Promise<HwSnapshot> {
  const state = await host.system.hardware.get();
  const snap = { state } as HwSnapshot;
  await Promise.all(
    (Object.keys(GETTERS) as ReadKnob[]).map(async (k) => {
      const status = state.knobs.find((x) => x.knob === k);
      if (!status?.available) {
        (snap[k] as Read<unknown>) = {};
        return;
      }
      try {
        (snap[k] as Read<unknown>) = { value: await GETTERS[k]() };
      } catch (e) {
        (snap[k] as Read<unknown>) = { error: asHostError(e) };
      }
    }),
  );
  return snap;
}

export const hw = new Cached<HwSnapshot>(readAll, 2000);

export const knobStatus = (snap: HwSnapshot | undefined, knob: HardwareKnob): KnobStatus | undefined =>
  snap?.state.knobs.find((k) => k.knob === knob);

/** The last provider or host notice per knob (`hardware.changed`), for status rows. */
export const notices = new Map<HardwareKnob, { reason: HardwareChangeReason; at: number }>();

export function onHardwareChanged(knob: HardwareKnob, reason: HardwareChangeReason): void {
  notices.set(knob, { reason, at: now() });
  hw.invalidate();
}

/** The provider's revert notices in words (hw1.xml FanMode1, Provider1.Changed). */
export const REVERT_TEXT: Partial<Record<HardwareChangeReason | string, string>> = {
  "reverted-temperature": "the CPU reached 90 °C",
  "reverted-sensor": "the CPU temperature could not be read",
  "reverted-sleep": "the device went to sleep",
  "reverted-disconnect": "Bathysphere disconnected from the helper",
  "reverted-stop": "the hardware helper stopped",
  temperature: "the CPU reached 90 °C",
  sensor: "the CPU temperature could not be read",
  sleep: "the device went to sleep",
  disconnect: "Bathysphere disconnected from the helper",
  stop: "the hardware helper stopped",
};

export const CHANGE_TEXT: Partial<Record<HardwareChangeReason, string>> = {
  "reasserted-ac": "set again after the charger changed (the firmware rewrites the limits then)",
  "reasserted-resume": "set again after waking from sleep",
  "capped-battery": "lowered to the battery maximum while unplugged",
  "raised-with-sustained": "boost raised to stay at or above sustained power",
  overridden: "another program changed it",
  "not-applied": "a write did not take",
  "lease-ended": "the lease ended and the default came back",
  rule: "a power profile rule applied",
};
