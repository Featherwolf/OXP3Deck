// The 0.4 CPU and GPU controls of a profile (DESIGN.md "Power 0.4", "Frontend 0.4"): CPU speed cap, CPU vs GPU
// balance, GPU power saving, CPU minimum speed, and behind "Show advanced CPU options" the per-core-type caps and
// energy preference. Values go through the caller's draft writer (powerWriter), like the other sliders.
import { ButtonItem, DropdownItem, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { FC, useState } from "react";

import { get_setting, set_setting } from "../backend";
import { friendlyName, lockedLine } from "../conflicts";
import { EFFECTS } from "../effects";
import {
  CAP_FIELD, CORE_NAME, CORE_SHORT, EPP_FIELD, EPP_LABELS, minPctRange, toCaps, toPct, usesCaps,
} from "../power";
import { put, useResource } from "../store";
import type { BlockedGroup, CoreType, Epp, PowerInfo, PowerState, PowerValues } from "../types";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { explainWhen, label, WithDetails } from "./Hint";

const det = (title: string, body: (string | null | undefined | false)[], lines?: string[]): DetailsSpec =>
  ({ title, body: paragraphs(body), lines });

/** "Locked by Intel low-power daemon." while a conflict blocks this field group, else null. */
export const lockedWhy = (group: BlockedGroup, state: PowerState, info: PowerInfo | null): string | null => {
  const ids = state.blocked_fields?.[group] ?? [];
  if (!ids.length) return null;
  return lockedLine(ids.map((id) => friendlyName(id, info?.conflicts.find((c) => c.id === id)?.name)));
};

const ADVANCED = "ui_power_advanced";
const useAdvanced = () => {
  const r = useResource<boolean>("ui:power-advanced", async () => (await get_setting(ADVANCED)) === true);
  const set = async (on: boolean) => { put("ui:power-advanced", on); await set_setting(ADVANCED, on); };
  return { on: !!r.data, set };
};

export const CpuControls: FC<{
  state: PowerState; info: PowerInfo | null; v: PowerValues; write: (values: Partial<PowerValues>) => void;
  active: boolean; quick?: boolean;
}> = ({ state, info, v, write, active, quick }) => {
  const adv = useAdvanced();
  const [switching, setSwitching] = useState(false);
  const cpu = info?.hw.cpu ?? null;
  const r = state.range;
  const now = state.now;
  const perf = !!cpu?.perf_pct;
  const soc = !!info?.hw.soc && now.soc !== null;
  const gpuProfile = !!info?.hw.gpu?.power_profile;
  const types = (cpu?.types ?? []).filter((t) => r.core_types?.[t]);
  const pctLock = lockedWhy("cpu_pct", state, info);
  const capsLock = lockedWhy("cpu_caps", state, info);
  const socLock = lockedWhy("soc", state, info);
  const eppLock = lockedWhy("epp", state, info);
  const caps = usesCaps(v);
  const pctMin = r.cpu_pct_min ?? 30;
  // what the controls show: the stored value, else (the profile runs now) what the CPU has, else the default
  const capShown = v.cpu_max_pct ?? (active ? now.cpu_max_pct : null) ?? 100;
  const effCap = v.cpu_max_pct ?? 100;
  const minR = minPctRange(r, effCap);
  const minShown = Math.min(minR.hi, Math.max(minR.lo, v.cpu_min_pct ?? (active && state.active.ac ? now.cpu_min_pct : null) ?? minR.lo));
  const balance = v.soc_balance ?? now.soc?.balance ?? 3;
  const offset = v.soc_offset ?? now.soc?.offset ?? 0;
  const balanced = now.soc?.profile === "balanced";
  const saving = (v.gpu_power_profile ?? (active ? now.gpu_profile : null) ?? "base") === "power_saving";
  const plugged = state.active.ac === true;
  const where = active ? null : "Saved now; used when this profile is active.";

  const switchTo = async (to: "caps" | "pct") => {
    setSwitching(true);
    try {
      const ok = await confirm(to === "caps"
        ? { title: "Use per-core caps?", ok: "Use per-core caps", text: "This turns off the CPU speed cap.", effect: EFFECTS["power.cpu_caps"] }
        : { title: "Use the CPU speed cap?", ok: "Use the speed cap", text: "This turns off the per-core caps.", effect: EFFECTS["power.cpu_max_pct"] });
      if (ok) write(to === "caps" ? toCaps({}) : toPct(null));
    } finally {
      setSwitching(false);
    }
  };

  const capD = det("CPU speed cap", [
    `Caps every core at this share of its top speed (${pctMin}–100 %). Lower leaves more of the power limit to the GPU in GPU-heavy games; 60–70 % is a good start on battery.`,
    "Steadier frame pacing at a fixed power limit is likely, but not measured on this device yet.",
    "Takes effect: Now. Resets at reboot; OXP3 Deck sets it again while power control is on.",
    "Either this or the per-core caps (advanced options), not both.",
    "With CPU boost off the cores stop at their base speed, so a high cap changes nothing.",
    "It shows only when the CPU wants to run faster than the cap: a CPU-heavy game slows down; in a GPU-heavy game held at the power limit the GPU gets a few watts more and the frame rate barely moves.",
    where,
  ], ["intel_pstate/max_perf_pct"]);
  const balD = det("CPU vs GPU balance", [
    "A hint to the chip's firmware about where the shared power goes: 1 favours the CPU, 5 the GPU, 3 is the device default.",
    "Works only while the system's power mode is Balanced; power-profiles-daemon's Balanced mode uses this value too.",
    "Takes effect: Now. The effect is not measured on this device yet.", where,
  ], ["processor_thermal_soc_slider slider_balance (+ slider_offset)", "platform-profile \"SoC Power Slider\" rewritten to balanced"]);
  const offD = det("Let the chip save more", [
    "Lets the firmware move the balance towards saving power by up to this much (0–3) when it sees fit. 0 = never.",
    "Takes effect: Now (only in the Balanced power mode).", where,
  ], ["slider_offset"]);
  const gpuD = det("GPU power saving", [
    "The GPU speeds up more slowly when load rises. Good with a frame limit; can stutter in heavy games without one.",
    "Render GPU only. Takes effect: Now. Resets at reboot; OXP3 Deck sets it again.", where,
  ], ["xe freq0/power_profile: base / power_saving"]);
  const minD = det("CPU minimum speed (plugged in)", [
    `The CPU never runs slower than this share of its top speed while plugged in, from the device's own floor (${minR.lo} %) to 50 %, never above the speed cap. Higher reacts faster and uses more power.`,
    "On battery the device's own floor is used: the slider keeps your value for when you plug in.",
    "Shows mostly at idle: a game's busy cores already run faster than this.", "Takes effect: Now.", where,
  ], ["intel_pstate/min_perf_pct"]);
  const advD = det("Show advanced CPU options", ["Shows a speed cap and an energy preference per core type (performance, efficient and low-power cores). Only changes this list."]);

  return (
    <>
      {perf && (
        <PanelSectionRow>
          <WithDetails details={capD}>
            <SliderField label={label("CPU speed cap", capD)} value={capShown} min={pctMin} max={100} step={5} showValue valueSuffix=" %"
              disabled={!!pctLock || caps || switching} editableValue={!quick}
              onChange={(x) => write({ cpu_max_pct: Math.min(100, Math.max(pctMin, Math.round(x))),
                ...(v.cpu_min_pct != null && v.cpu_min_pct > x ? { cpu_min_pct: Math.max(minR.lo, Math.min(50, Math.round(x))) } : {}) })}
              description={explainWhen("Lower leaves more power for the GPU in GPU-heavy games.", EFFECTS["power.cpu_max_pct"],
                pctLock ?? (caps ? "Uses the per-core caps." : null))} />
          </WithDetails>
          {caps && !pctLock && (
            <ButtonItem layout="below" disabled={switching} onClick={() => switchTo("pct")}
              description={explainWhen("Turns the per-core caps off.", EFFECTS["power.cpu_max_pct"])}>Use the CPU speed cap instead</ButtonItem>
          )}
        </PanelSectionRow>
      )}
      {soc && (
        <PanelSectionRow>
          <WithDetails details={balD}>
            <SliderField label={label("CPU vs GPU balance", balD)} value={balance} min={1} max={5} step={1} showValue
              notchCount={5} notchTicksVisible notchLabels={[{ notchIndex: 0, label: "CPU", value: 1 }, { notchIndex: 4, label: "GPU", value: 5 }]}
              disabled={!!socLock || !balanced} onChange={(x) => write({ soc_balance: Math.min(5, Math.max(1, Math.round(x))) })}
              description={explainWhen("Hint to the chip: favour the CPU (1) or the GPU (5).", EFFECTS["power.soc"],
                socLock ?? (!balanced ? "Only in the Balanced power mode." : null))} />
          </WithDetails>
          {!quick && (
            <WithDetails details={offD}>
              <SliderField label={label("Let the chip save more", offD)} value={offset} min={0} max={3} step={1} showValue
                disabled={!!socLock || !balanced} onChange={(x) => write({ soc_offset: Math.min(3, Math.max(0, Math.round(x))) })}
                description={explainWhen("Lets the firmware lean towards saving power by up to this much.", EFFECTS["power.soc_offset"],
                  socLock ?? (!balanced ? "Only in the Balanced power mode." : null))} />
            </WithDetails>
          )}
        </PanelSectionRow>
      )}
      {gpuProfile && (
        <PanelSectionRow>
          <WithDetails details={gpuD}>
            <ToggleField label={label("GPU power saving", gpuD)} checked={saving}
              onChange={(c) => write({ gpu_power_profile: c ? "power_saving" : "base" })}
              description={explainWhen("GPU speeds up more slowly. Good with a frame limit.", EFFECTS["power.gpu_profile"])} />
          </WithDetails>
        </PanelSectionRow>
      )}
      {perf && (
        <PanelSectionRow>
          <WithDetails details={minD}>
            <SliderField label={label("CPU minimum speed (plugged in)", minD)} value={minShown} min={minR.lo} max={Math.max(minR.lo + 1, minR.hi)} step={1}
              showValue valueSuffix=" %" editableValue={!quick}
              disabled={!!pctLock || minR.hi <= minR.lo || (quick && !plugged)}
              onChange={(x) => write({ cpu_min_pct: Math.min(minR.hi, Math.max(minR.lo, Math.round(x))) })}
              description={explainWhen("Higher reacts faster, uses more power.", EFFECTS["power.cpu_min_pct"],
                pctLock ?? (minR.hi <= minR.lo ? "The speed cap is at the device's floor."
                  : active && state.active.ac === false ? `On battery: the device's own floor (${minR.lo} %) runs now.`
                  : quick && !plugged ? "Only while plugged in." : null))} />
          </WithDetails>
        </PanelSectionRow>
      )}
      {(types.length > 0 || (cpu?.epp_choices.length ?? 0) > 0) && (perf || types.length > 0) && (
        <PanelSectionRow>
          <WithDetails details={advD}>
            <ToggleField label={label("Show advanced CPU options", advD)} checked={adv.on} onChange={(c) => adv.set(c)}
              description="Caps and energy preference per core type." />
          </WithDetails>
        </PanelSectionRow>
      )}
      {adv.on && types.length > 0 && (
        <PanelSectionRow>
          {types.map((t) => {
            const tr = r.core_types?.[t] as { min_mhz: number; max_mhz: number };
            const f = CAP_FIELD[t];
            const shownCap = Math.min(tr.max_mhz, Math.max(tr.min_mhz, v[f] ?? (active ? now.caps_mhz?.[t] : null) ?? tr.max_mhz));
            const d = det(`${CORE_NAME[t]} max`, [
              `Caps the ${CORE_SHORT[t]} at this speed (${tr.min_mhz}–${tr.max_mhz} MHz).`,
              "Either these or the CPU speed cap, not both: switching asks first.", "Takes effect: Now.", where,
            ], ["cpufreq policyN/scaling_max_freq of this core type", "core types: /sys/devices/cpu_core, cpu_atom (no L3: low-power)"]);
            return (
              <WithDetails key={t} details={d}>
                <SliderField label={label(`${CORE_NAME[t]} max`, d)} value={shownCap} min={tr.min_mhz} max={tr.max_mhz} step={100}
                  showValue valueSuffix=" MHz" disabled={!!capsLock || v.cpu_max_pct != null || switching} editableValue={!quick}
                  onChange={(x) => write({ [f]: Math.min(tr.max_mhz, Math.max(tr.min_mhz, Math.round(x / 100) * 100)) } as Partial<PowerValues>)}
                  description={explainWhen("Limit these cores' top speed.", EFFECTS["power.cpu_caps"],
                    capsLock ?? (v.cpu_max_pct != null ? "Uses the CPU speed cap." : null))} />
              </WithDetails>
            );
          })}
          {v.cpu_max_pct != null && !capsLock && (
            <ButtonItem layout="below" disabled={switching} onClick={() => switchTo("caps")}
              description={explainWhen("Turns the CPU speed cap off.", EFFECTS["power.cpu_caps"])}>Use per-core caps instead</ButtonItem>
          )}
        </PanelSectionRow>
      )}
      {adv.on && types.length > 1 && cpu && cpu.epp_choices.length > 0 && (
        <PanelSectionRow>
          {types.map((t: CoreType) => {
            const f = EPP_FIELD[t];
            const d = det(`Energy preference: ${CORE_SHORT[t]}`, [
              `How eagerly the ${CORE_SHORT[t]} speed up. "Same as above" uses the profile's energy preference.`,
              "The gain over one preference for all cores is small and not measured yet.", "Takes effect: Now.", eppLock, where,
            ], ["energy_performance_preference of each policy of this core type"]);
            const opts = [{ data: null as Epp | null, label: "Same as above" },
              ...(Object.keys(EPP_LABELS) as Epp[]).filter((e) => cpu.epp_choices.includes(e)).map((e) => ({ data: e as Epp | null, label: EPP_LABELS[e] }))];
            return (
              <WithDetails key={t} details={d}>
                <DropdownItem label={label(`Energy preference: ${CORE_SHORT[t]}`, d)} disabled={!!eppLock}
                  rgOptions={opts} selectedOption={v[f]} onChange={(o) => write({ [f]: o.data as Epp | null } as Partial<PowerValues>)}
                  description={explainWhen("How eagerly these cores speed up.", EFFECTS["power.epp_split"], eppLock)} />
              </WithDetails>
            );
          })}
        </PanelSectionRow>
      )}
    </>
  );
};
