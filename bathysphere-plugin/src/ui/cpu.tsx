// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * CPU and GPU: the speed cap or per-core caps, the minimum speed plugged in, energy preference (or
 * power-profiles-daemon's energy mode while it owns EPP), the CPU vs GPU balance, CPU boost and GPU
 * power saving (original CpuControls.tsx and the CPU half of PowerControls.tsx).
 */
import { host, Select, Slider, Toggle, type Element } from "@bathysphere/sdk";
import { debounce } from "../core/redraw";
import { details } from "../core/text";
import { isCachyOs, info } from "../device/info";
import type { HwSnapshot } from "../hw/knobs";
import { setCpuBoost, setGpuProfile, writeErrors } from "../hw/steam";
import { conflicts, editSlot, power } from "../power/apply";
import { cpuLockers, lockedLine, offCard } from "../power/conflicts";
import { CAP_FIELD, CORE_NAME, CORE_TYPES, EPP_FIELD, slotValues, usesCaps, type CoreType } from "../power/profiles";
import { prefs } from "./prefs";
import { Card, ErrorRow, Status } from "./rows";
import { snap } from "./slider";
import type { Target } from "./power";
import type { View } from "./view";

const EPP_LABEL: Record<string, string> = { default: "Device default", performance: "Performance", balance_performance: "Balance performance", balance_power: "Balance power", power: "Power saving" };
const ENERGY_LABEL: Record<string, string> = { "power-saver": "Power saver", balanced: "Balanced", performance: "Performance" };
const label = (map: Record<string, string>, x: string) => map[x] ?? x;

/** "Cap 80 % · Min 10 % · Energy: Balance power · Boost: on · Balance 3". */
export function cpuNowLine(s: HwSnapshot): string {
  const c = s.cpuLimits.value;
  const e = s.epp.value ? Object.values(s.epp.value.byType)[0] : null;
  const parts = [
    c ? `Cap ${c.maxPerfPct} % · Min ${c.minPerfPct} %` : null,
    e ? `Energy: ${label(EPP_LABEL, e)}` : s.energy.value ? `Mode: ${label(ENERGY_LABEL, s.energy.value.profile)}` : null,
    s.cpuBoost.value ? `Boost: ${s.cpuBoost.value.enabled ? "on" : "off"}` : null,
    s.socBalance.value ? `Balance ${s.socBalance.value.balance}${s.socBalance.value.active ? "" : " (held)"}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "No CPU controls";
}

/** The red rows: the performance governor, programs that take energy preference. */
export function cpuAlerts(s: HwSnapshot | undefined): Element[] {
  const out: Element[] = [];
  if (s?.governor.value?.governor === "performance") {
    out.push(<Status label="CPU speed policy is Performance" line="Energy preference and minimum speed don't apply; the CPU runs at its cap." tone="bad" more="A reboot or the desktop's power settings reset it. OXP3 Deck never sets the CPU speed policy." />);
  }
  const lockers = cpuLockers(conflicts.value);
  if (lockers.length && !s?.epp.value) {
    out.push(<Status label="Energy preference" line={lockedLine(lockers)} tone="warn" more={["While power-profiles-daemon, TuneD or Intel's low-power daemon runs, it sets the energy preference itself. OXP3 Deck then uses its power modes (Energy mode) where it can.", "The card turns it off; then energy preference per profile works."]} />);
    for (const c of lockers) {
      const card = offCard(c.id);
      if (card) out.push(<Card id={card.id} {...(card.steps ? { steps: card.steps } : {})} />);
    }
  }
  return out;
}

/** The CPU controls of one slot. `full`: the panel (minimum speed, advanced, offset). */
export function cpuControls(v: View, s: HwSnapshot, t: Target, full: boolean): Element[] {
  const out: Element[] = [];
  const values = slotValues(power.value.profiles[t.key]!, t.slot);
  const edit = (change: Parameters<typeof editSlot>[2]) => editSlot(t.key, t.slot, change);
  const c = s.cpuLimits.value;
  if (c) {
    if (usesCaps(values)) {
      out.push(<Status label="CPU speed: per-core caps" line="Set below; the speed cap is off." />);
      if (full) {
        out.push(
          <Toggle
            label="Use the CPU speed cap instead"
            value={false}
            onChange={async () => {
              const ok = await host.ui.confirm({ title: "Use the CPU speed cap?", body: "The per-core caps of this profile are cleared: the CPU uses either the speed cap or per-core caps, not both.", ok: "Switch" });
              if (ok) await edit({ capP: null, capE: null, capLpe: null });
            }}
          />,
        );
      }
    } else {
      const pct = snap(values.cpuMaxPct ?? c.maxPerfPct, c.maxPerfPctMin, 100, 5);
      out.push(
        <Slider
          label="CPU speed cap"
          min={c.maxPerfPctMin}
          max={100}
          step={5}
          value={pct}
          valueLabel={values.cpuMaxPct === null ? `device (${c.maxPerfPct} %)` : `${pct} %`}
          onChange={(x) => debounce(`cap:${v.key}`, 400, () => void edit({ cpuMaxPct: x }))}
          details={details("CPU speed cap", "The highest CPU speed in percent of its maximum (intel_pstate max_perf_pct). A lower cap leaves more of the power to the GPU.")}
        />,
      );
    }
    if (full) {
      const top = Math.min(50, values.cpuMaxPct ?? 100);
      const min = snap(values.cpuMinPct ?? Math.min(c.minPerfPct || 1, top), 1, top, 1);
      out.push(
        <Slider
          label="CPU minimum speed (plugged in)"
          min={1}
          max={top}
          step={1}
          value={min}
          valueLabel={values.cpuMinPct === null ? "device" : `${min} %`}
          onChange={(x) => debounce(`min:${v.key}`, 400, () => void edit({ cpuMinPct: x }))}
          details={details("CPU minimum speed", "Applies only while plugged in (the helper refuses it on battery), at most 50 % and never above the speed cap. On battery the device keeps its own floor.")}
        />,
      );
    }
  }
  const sb = s.socBalance.value;
  if (sb && sb.balanceMax > sb.balanceMin) {
    const bal = snap(values.socBalance ?? sb.balance, sb.balanceMin, sb.balanceMax, 1);
    out.push(
      <Slider
        label="CPU vs GPU balance"
        min={sb.balanceMin}
        max={sb.balanceMax}
        step={1}
        value={bal}
        valueLabel={`${bal}${sb.active ? "" : " (held)"}`}
        onChange={(x) => debounce(`soc:${v.key}`, 400, () => void edit({ socBalance: x, socOffset: values.socOffset ?? sb.offset }))}
        details={details("CPU vs GPU balance", ["How the chip shares its power between CPU and GPU (the SoC power slider).", sb.active ? null : "Only in the Balanced power mode: the value is held and applies when the mode is Balanced."])}
      />,
    );
    if (full && sb.offsetMax > 0) {
      const off = snap(values.socOffset ?? sb.offset, 0, sb.offsetMax, 1);
      out.push(<Slider label="Let the chip save more" min={0} max={sb.offsetMax} step={1} value={off} valueLabel={`${off}`} onChange={(x) => debounce(`socoff:${v.key}`, 400, () => void edit({ socBalance: values.socBalance ?? sb.balance, socOffset: x }))} />);
    }
  }
  const e = s.epp.value;
  if (e) {
    out.push(
      <Select
        label="Energy preference"
        options={[{ value: "", label: "Device default" }, ...e.available.map((x) => ({ value: x, label: label(EPP_LABEL, x) }))]}
        value={values.epp && e.available.includes(values.epp) ? values.epp : ""}
        onChange={(x) => edit({ epp: x || null })}
        details={details("Energy preference (EPP)", "How eagerly the CPU clocks up. Power saving and Balance power save battery; Performance answers fastest.")}
      />,
    );
  } else if (s.energy.value) {
    const en = s.energy.value;
    out.push(
      <Select
        label="Energy mode"
        options={[{ value: "", label: "As the desktop sets it" }, ...en.available.map((x) => ({ value: x, label: label(ENERGY_LABEL, x) }))]}
        value={values.energy && en.available.includes(values.energy) ? values.energy : ""}
        onChange={(x) => edit({ energy: x || null })}
        details={details("Energy mode", ["power-profiles-daemon runs, so it owns energy preference. OXP3 Deck asks it for Power saver, Balanced or Performance per profile instead.", en.degraded ? `It reports: ${en.degraded}.` : null])}
      />,
    );
  }
  if (s.cpuBoost.value) {
    out.push(<Toggle label="CPU boost" description="Steam's setting: applies now, not per profile." value={s.cpuBoost.value.enabled} onChange={async (x) => void (await setCpuBoost(x))} />, <ErrorRow error={writeErrors.get("cpuBoost")} />);
  }
  const gp = s.gpuPowerProfile.value;
  if (gp && gp.available.includes("power_saving")) {
    const base = gp.available.find((x) => x !== "power_saving") ?? "base";
    out.push(<Toggle label="GPU power saving" description="Steam's setting: applies now, not per profile." value={gp.profile === "power_saving"} onChange={async (x) => void (await setGpuProfile(x ? "power_saving" : base))} />, <ErrorRow error={writeErrors.get("gpuPowerProfile")} />);
  }
  if (full && c) {
    out.push(<Toggle label="Show advanced CPU options" value={prefs.value.advancedCpu} onChange={(x) => prefs.save({ ...prefs.value, advancedCpu: x }).then(() => undefined)} />);
    if (prefs.value.advancedCpu) out.push(...advancedRows(v, s, t));
  }
  return out;
}

/** Per-core-type caps and energy preferences. */
function advancedRows(v: View, s: HwSnapshot, t: Target): Element[] {
  const out: Element[] = [];
  const values = slotValues(power.value.profiles[t.key]!, t.slot);
  const edit = (change: Parameters<typeof editSlot>[2]) => editSlot(t.key, t.slot, change);
  const c = s.cpuLimits.value!;
  const types = CORE_TYPES.filter((x) => c.coreTypeRange[x]);
  for (const ct of types) {
    const [lo, hi] = c.coreTypeRange[ct]!;
    if (hi <= lo) continue;
    const cur = snap(values[CAP_FIELD[ct]] ?? c.coreTypeMaxMhz[ct] ?? hi, lo, hi, 100);
    out.push(
      <Slider
        label={`${CORE_NAME[ct]}: maximum`}
        min={lo}
        max={hi}
        step={100}
        value={cur}
        valueLabel={values[CAP_FIELD[ct]] === null ? `device (${c.coreTypeMaxMhz[ct] ?? hi} MHz)` : `${cur} MHz`}
        onChange={(x) =>
          debounce(`capt:${ct}:${v.key}`, 400, async () => {
            if (values.cpuMaxPct !== null) {
              const ok = await host.ui.confirm({ title: "Use per-core caps?", body: "The CPU speed cap of this profile is cleared: the CPU uses either the speed cap or per-core caps, not both.", ok: "Switch" });
              if (!ok) return;
            }
            await edit({ cpuMaxPct: null, [CAP_FIELD[ct]]: x });
          })
        }
      />,
    );
  }
  const e = s.epp.value;
  if (e) {
    for (const ct of e.types.filter((x): x is CoreType => (CORE_TYPES as readonly string[]).includes(x))) {
      const cur = values[EPP_FIELD[ct]];
      out.push(
        <Select
          label={`${CORE_NAME[ct]}: energy preference`}
          options={[{ value: "", label: "Same as above" }, ...e.available.map((x) => ({ value: x, label: label(EPP_LABEL, x) }))]}
          value={cur && e.available.includes(cur) ? cur : ""}
          onChange={(x) => edit({ [EPP_FIELD[ct]]: x || null })}
        />,
      );
    }
  }
  return out;
}

/** CachyOS's scheduler mode: a card, since Bathysphere never calls scx_loader. */
export function schedulerRows(): Element[] {
  if (!isCachyOs(info.value)) return [];
  return [
    <Status label="CPU scheduler mode" line="Set in CachyOS Kernel Manager, before a game starts." more="The original OXP3 Deck switched scx_lavd's mode per profile. Bathysphere never calls the scheduler loader, so the card says where to change it." />,
    <Card id="scx-mode" />,
  ];
}
