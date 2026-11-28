// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Fan and battery (original ExtrasControls.tsx): the fan mode per profile (with power control off,
 * set directly, as the original offered it then too), the charge limit and "Run from charger". The
 * provider returns the fan and charging to Auto on its own safety rules (90 °C, an unreadable
 * sensor, sleep, Bathysphere going away); this shows why when it did.
 */
import { Button, Select, Slider, Toggle, type Element } from "@bathysphere/sdk";
import { details } from "../core/text";
import { info, kernelAtLeast74 } from "../device/info";
import { knobStatus, notices, REVERT_TEXT, type HwSnapshot } from "../hw/knobs";
import { drafts, setChargeBehaviour, setChargeLimit, setFan, writeErrors, written } from "../hw/steam";
import { hwPending } from "../core/queue";
import { editSlot, power, rulesError, scheduleRules, takeControl } from "../power/apply";
import { slotValues } from "../power/profiles";
import { ErrorRow, Status } from "./rows";
import { snap } from "./slider";
import { knobErrorRows, overrideRows, type Target } from "./power";

const FAN_LABEL: Record<string, string> = { auto: "Auto", quiet: "Quiet", max: "Max" };

/** "Fan went back to Auto: the CPU reached 90 °C" when the provider reverted it. */
function revertRow(s: HwSnapshot): Element | null {
  const r = s.fan.value?.reverted;
  const n = notices.get("fan");
  const why = r ? REVERT_TEXT[r] : n && n.reason.startsWith("reverted-") ? REVERT_TEXT[n.reason] : null;
  return why ? <Status label="Fan went back to Auto" line={`Because ${why}.`} tone="warn" more={["The hardware helper does this on its own: at 90 °C or when the CPU temperature cannot be read (then Quiet is refused for 10 minutes), before sleep, and when Bathysphere or the helper stops.", "Choose the mode again to set it once more."]} /> : null;
}

/** Linux 7.4 brings the fan and charge controls of this device (extras.py _gates). */
function kernelRow(s: HwSnapshot): Element | null {
  const fan = knobStatus(s, "fan");
  const charge = knobStatus(s, "chargeBehaviour");
  const needs = [fan, charge].some((k) => k && !k.available && /kernel/i.test(k.reason ?? "")) || kernelAtLeast74(info.value) === false;
  return needs ? <Status label="Fan and charging need Linux 7.4 or newer" line={`This is Linux ${info.value?.kernel ?? "?"}.`} tone="warn" more="The ONEXPLAYER 3's fan and charge controls arrive with the oxpec driver in Linux 7.4. Update the kernel (CachyOS: the Kernel tab)." /> : null;
}

export function batteryControls(s: HwSnapshot, t: Target): Element[] {
  const out: Element[] = [];
  const k = kernelRow(s);
  if (k) out.push(k);
  const fan = s.fan.value;
  if (fan) {
    if (power.value.enabled) {
      const values = slotValues(power.value.profiles[t.key]!, t.slot);
      const mode = values.fan ?? "auto";
      out.push(
        <Select
          label="Fan"
          options={fan.modes.map((m) => ({ value: m, label: FAN_LABEL[m] ?? m }))}
          value={fan.modes.includes(mode) ? mode : fan.modes[0]!}
          onChange={(m) => editSlot(t.key, t.slot, { fan: m === "auto" ? null : m })}
          details={details("Fan", ["Auto: the device's own fan curve. Quiet: a fixed low speed. Max: full speed. Per profile.", "Quiet goes back to Auto at 90 °C; both go back to Auto when the temperature cannot be read, before sleep and when Bathysphere stops. The first time, Bathysphere Home asks you to confirm."])}
        />,
      );
    } else {
      out.push(
        <Select
          label="Fan"
          options={fan.modes.map((m) => ({ value: m, label: FAN_LABEL[m] ?? m }))}
          value={fan.modes.includes(fan.mode) ? fan.mode : fan.modes[0]!}
          onChange={async (m) => void (await setFan(m))}
          details={details("Fan", ["Auto: the device's own fan curve. Quiet: a fixed low speed. Max: full speed. Applies now; with power control on, the fan is part of each profile.", "Quiet goes back to Auto at 90 °C; both go back to Auto when the temperature cannot be read, before sleep and when Bathysphere stops. The first time, Bathysphere Home asks you to confirm."])}
        />,
        <ErrorRow error={writeErrors.get("fan")} />,
      );
    }
    const r = revertRow(s);
    if (r) out.push(r);
  }
  if (rulesError && /fan|confirm|cooldown|sleep/i.test(rulesError.message)) out.push(<ErrorRow label="Fan: not changed" error={rulesError} />);
  const cl = s.chargeLimit.value;
  if (cl && cl.max > cl.min) {
    const pct = Math.min(cl.max, Math.max(cl.min, drafts.get("chargeLimit") ?? cl.percent));
    out.push(
      <Slider
        label="Charge limit"
        min={cl.min}
        max={cl.max}
        step={5}
        value={snap(pct, cl.min, cl.max, 5)}
        valueLabel={pct >= 100 ? "Charges fully" : `Stops at ${pct} %`}
        onChange={(x) => setChargeLimit(x)}
        details={details("Charge limit", ["Charging stops at this level, which keeps the battery healthier on the charger. Steam's own setting: the hardware helper keeps it across reboots.", "Below 80 % Bathysphere Home asks once to confirm. A change is sent at most every 10 s; the newest value waits."])}
      />,
      <ErrorRow error={writeErrors.get("chargeLimit")} />,
    );
  }
  const cb = s.chargeBehaviour.value;
  if (cb && cb.available.includes("inhibit-charge-awake")) {
    out.push(
      <Toggle
        label="Run from charger"
        description="While awake on the charger, the battery is not charged."
        value={cb.value === "inhibit-charge-awake"}
        onChange={async (on) => {
          const o = await setChargeBehaviour(on ? "inhibit-charge-awake" : "auto");
          if (o.ok && power.value.enabled) scheduleRules();
        }}
        details={details("Run from charger", ["The device runs from the charger while awake and leaves the battery as it is; it charges again when it sleeps, when you turn this off, and when Bathysphere stops.", "The first time, Bathysphere Home asks you to confirm."])}
      />,
      <ErrorRow error={writeErrors.get("chargeBehaviour")} />,
    );
  }
  // Steam's knobs have no lease: the last writer wins, so a value other than ours means someone else wrote it
  const now = { chargeLimit: cl?.percent, chargeBehaviour: cb?.value };
  for (const knob of ["chargeLimit", "chargeBehaviour"] as const) {
    const mine = written.get(knob);
    if (mine !== undefined && now[knob] !== undefined && now[knob] !== mine && !hwPending(knob)) {
      out.push(<Status label={knob === "chargeLimit" ? "Something else changed the charge limit" : "Something else changed Run from charger"} line={`Steam or another program set it (OXP3 Deck set ${String(mine)}).`} tone="bad" />, <Button label="Take control" onClick={() => takeControl(knob)} />);
    }
  }
  out.push(...knobErrorRows(s, ["fan", "chargeLimit", "chargeBehaviour"]), ...overrideRows(s, ["fan", "chargeBehaviour"]));
  return out;
}
