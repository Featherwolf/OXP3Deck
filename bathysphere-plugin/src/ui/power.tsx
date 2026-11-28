// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Power: status, power control, presets, sustained and boost power, the GPU speed range, other power
 * programs, overrides, the profile editor, low battery, live readouts and the device check
 * (original PowerControls.tsx, PerfRows.tsx, pages/Power.tsx).
 */
import { Button, Chips, Field, host, ListItem, Select, Slider, Text, Toggle, type Element, type HardwareKnob, type PowerConflict } from "@bathysphere/sdk";
import { explain } from "../core/errors";
import { debounce } from "../core/redraw";
import { andList, details, dialogTitle, fit } from "../core/text";
import { offerUndo, runUndo, undoLabel } from "../core/undo";
import { batteryNow, info, usesPacman } from "../device/info";
import { CHANGE_TEXT, hw, knobStatus, notices, type HwSnapshot, type ReadKnob } from "../hw/knobs";
import { drafts, setCpuBoost, setGpuProfile, setTdp, setTdpNow, writeErrors } from "../hw/steam";
import { activeTarget, conflicts, editSlot, forgetTurnedOff, lastRules, power, profiles, readConflicts, refused, resetSlot, rulesError, rulesOutOfDate, setEnabled, setGameProfile, setIgnored, setOptions, takeControl, turnedOff, unchecked, writeRules } from "../power/apply";
import { blocking, cameBack, cameBackText, conflictText, ignorable, offAllSteps, offCard, onCard } from "../power/conflicts";
import { liveRows, LIVE_SOURCES, reasonText, lastSample } from "../power/live";
import { LOW_SLIDER, presetNumbers, presetOf, PRESET_IDS, PRESET_LABEL, PRESETS, slotValues, type PresetId, type Slot } from "../power/profiles";
import { ruleTarget } from "../power/rules";
import { checkLine, measureLine, owedText, probeLine, putBackOwed, runCheck, runMeasure, selftest, task } from "../power/selftest";
import { anyRunning, appName, currentGame, library } from "../games/running";
import { Card, ErrorRow, Status, Unread } from "./rows";
import { snap } from "./slider";
import { liveViews, setState, stateOf, type View } from "./view";

export interface Target {
  key: string;
  slot: Slot;
}

const clampIn = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** "Default", "Cyberpunk 2077", with the slot ("plugged in", "low battery"). */
export function targetName(t: Target): string {
  const p = power.value.profiles[t.key];
  const name = t.key === "default" ? "Default" : (p?.name ?? appName(Number(t.key)));
  return t.slot === "ac" ? `${name}, plugged in` : t.slot === "low" ? `${name}, low battery` : name;
}

/** The hardware helper is missing, off or not usable: the explanation and its card. */
export function helperRows(s: HwSnapshot | undefined): Element | null {
  if (!s) return null;
  const p = s.state.provider;
  const tdpNone = knobStatus(s, "tdp")?.backend === "none";
  if (!p) {
    const pacman = usesPacman(info.value);
    return (
      <>
        <Status
          label="The ONEXPLAYER 3 hardware helper is not installed"
          line={pacman ? "Boost, CPU limits, fan and charging need it." : "It is packaged for CachyOS only, so boost, CPU limits, fan and charging stay off here."}
          tone="warn"
          more={["oxp3-hw (daemon oxp3-hwd) is a system package that lets Steam and Bathysphere set this device's power limits, GPU, CPU, fan and charging, within safe limits and never as root. Bathysphere never installs software: the card shows the commands, and this page sees the helper once it runs (after a reboot).", pacman ? null : "Its package is a pacman package (CachyOS, Arch). There is none for this system yet; XeSS and per-game launch options work without it."]}
        />
        {pacman ? <Card id="hw-install" /> : null}
      </>
    );
  }
  const why: Record<string, string> = {
    unrecognised: "Bathysphere does not know this helper or this version.",
    revoked: "This helper version was withdrawn: update or remove it.",
    disabled: "The helper is turned off (/etc/oxp3-hw/disabled).",
    "grants-missing": "The helper lacks access to the hardware: reboot once.",
  };
  const rows: Element[] = [];
  if (p.state !== "ok") {
    rows.push(<Status label={`Hardware helper: ${p.state}`} line={why[p.state] ?? p.state} tone="warn" more={`${p.name} ${p.version} (device ${p.device}, API ${p.api}).`} />);
    rows.push(p.state === "disabled" ? <Card id="hw-stop" steps={[1]} /> : <Card id="hw-install" />);
  }
  if (tdpNone) rows.push(<Status label="Steam's TDP control is missing" line="steamos-manager does not run: install it." tone="warn" />, ...(usesPacman(info.value) ? [<Card id="hw-install" steps={[0]} />] : []));
  return rows.length ? <>{rows}</> : null;
}

/** Overridden knobs and the provider's reverts, each with Take control (original drift rows). */
export function overrideRows(s: HwSnapshot | undefined, knobs: readonly HardwareKnob[]): Element[] {
  const out: Element[] = [];
  for (const k of knobs) {
    const st = knobStatus(s, k);
    if (!st?.overridden) continue;
    const suspects = (conflicts.value ?? []).filter((c) => c.active).map((c) => conflictText(c).name);
    out.push(
      <Status
        label={`Something else changed ${KNOB_NAME[k] ?? k}`}
        line={suspects.length ? `Likely: ${andList(suspects)}.` : "Fix it, then Take control."}
        tone="bad"
        more={["The hardware helper stopped setting it instead of fighting the other program. Turn that program's control off, then Take control. Bathysphere Home → Hardware has Take control too.", suspects.length ? `Running now: ${andList(suspects)}.` : null]}
      />,
      <Button label={`Take control of ${KNOB_NAME[k] ?? k}`} onClick={() => takeControl(k)} />,
    );
  }
  return out;
}

export const KNOB_NAME: Partial<Record<HardwareKnob, string>> = {
  tdp: "sustained power",
  boost: "boost power",
  epp: "energy preference",
  energy: "the energy mode",
  cpuLimits: "the CPU limits",
  socBalance: "the CPU vs GPU balance",
  gpuRange: "the GPU speed range",
  gpuPowerProfile: "GPU power saving",
  cpuBoost: "CPU boost",
  governor: "the CPU speed policy",
  fan: "the fan",
  chargeLimit: "the charge limit",
  chargeBehaviour: "Run from charger",
};

/** One conflict row with its card (original ConflictRow). */
function conflictRow(c: PowerConflict): Element {
  const t = conflictText(c);
  const back = cameBack(c, turnedOff.value.off);
  const card = offCard(c.id);
  const ignored = power.value.ignored.includes(c.id);
  return (
    <>
      <Status
        label={t.name}
        line={back ? cameBackText(c.id) : ignored ? "Marked as handled." : t.line}
        tone={ignored ? "neutral" : c.kind === "blocks" ? "bad" : "warn"}
        more={[...t.body, c.how ? `Bathysphere says: ${c.how}` : null, c.unit ? `Unit: ${c.unit}` : null]}
      />
      {card ? <Card id={card.id} {...(card.steps ? { steps: card.steps } : {})} /> : null}
      {ignorable(c.id) ? <Toggle label="I've handled it" value={ignored} onChange={(v) => setIgnored(c.id, v)} /> : null}
      {back ? <Button label="I turned it on again on purpose" onClick={() => forgetTurnedOff(c.id)} /> : null}
    </>
  );
}

/** Active conflicts: blocking first (red), then CPU ones; Turn off all for 2 or more. */
export function conflictRows(full: boolean): Element[] {
  const active = (conflicts.value ?? []).filter((c) => c.active);
  const rows = (full ? active : active.filter((c) => c.kind === "blocks" && !power.value.ignored.includes(c.id))).map(conflictRow);
  if (full && conflicts.error) rows.unshift(<ErrorRow label="Other power programs: not read" error={explain(conflicts.error)} />);
  const steps = offAllSteps(active.filter((c) => !power.value.ignored.includes(c.id)).map((c) => c.id));
  if (full && steps.length >= 2) rows.push(<Card id="power-off" steps={steps} />);
  if (full) {
    if (conflicts.value && !active.length) rows.unshift(<Status label="No other power program runs" line="Nothing else changes the power limits now." tone="good" />);
    for (const [id, rec] of Object.entries(turnedOff.value.off)) {
      if (active.some((c) => c.id === id)) continue;
      const card = onCard(id);
      rows.push(
        <ListItem label={`${conflictText({ id, name: id }).name}: turned off`} description="Seen stopped {} after its card." date={rec.at} details={details("Turned off", "OXP3 Deck saw this program stop after it showed its card. It cannot know whether it ran at boot before; the card enables and starts it.")} />,
        ...(card ? [<Card id={card.id} steps={card.steps} />] : []),
        <Button label="Forget this" onClick={() => forgetTurnedOff(id)} />,
      );
    }
    rows.push(<Button label="Check again" icon="refresh" onClick={() => readConflicts(true)} details={details("Check again", "Looks for other power programs now (after you ran a card's steps). OXP3 Deck also looks every minute while a surface is open.")} />);
  }
  return rows;
}

/** The power status row: on or off, the active rule, notices from the provider. */
export function powerStatus(s: HwSnapshot | undefined): Element {
  const on = power.value.enabled;
  const active = profiles.value?.active;
  const t = ruleTarget(active?.rule);
  const tdp = s?.tdp.value;
  const boost = s?.boost.value;
  const line = !on ? "Off · device defaults" : `${tdp ? `${tdp.watts} W steady` : "?"} · ${boost ? `${boost.effective} W boost` : "boost ?"} · ${t ? targetName(t) : "Default"}`;
  const news = [...notices.entries()].filter(([, n]) => CHANGE_TEXT[n.reason]).map(([k, n]) => `${KNOB_NAME[k] ?? k}: ${CHANGE_TEXT[n.reason]}`);
  return (
    <Status
      label={on ? "Power control: on" : "Power control: off"}
      line={fit(line)}
      tone={on ? "good" : "neutral"}
      more={[
        on ? "The hardware helper applies your profiles also while OXP3 Deck is closed: when a game starts or stops, the charger changes, the battery runs low or the device wakes." : "Nothing is set: the device runs at its defaults. Sustained power stays Steam's.",
        tdp?.capped === "battery" ? `Runs at ${tdp.effective} W on battery (the plugged-in limit is higher).` : null,
        news.length ? `Recent: ${news.join("; ")}.` : null,
      ]}
    />
  );
}

/**
 * The low-battery values while they run, or while a game's own profile holds them back (original
 * power.ts lowLine). hostd ends them when the battery is back at the level + 2 % or on the charger.
 */
export function lowRows(): Element[] {
  const o = power.value.options;
  if (!power.value.enabled || !o.lowBattery) return [];
  const b = batteryNow();
  const pct = b ? `${b.percent} %` : "Low battery";
  if (ruleTarget(profiles.value?.active.rule)?.slot === "low") {
    return [<Status label="Low battery" line={`${pct}: saving power until ${o.lowPct + 2} % or plugged in.`} tone="warn" more="The low-battery values run: each limit the lower of the profile's and the low values. Change them on the Power tab (Default, Low battery)." />];
  }
  const g = currentGame();
  if (b && !b.ac && b.percent < o.lowPct && g !== null && o.perGame && !o.lowGames && power.value.profiles[String(g)]) {
    const name = power.value.profiles[String(g)]?.name ?? appName(g);
    return [<Status label="Low battery" line={fit(`${pct}: ${name} keeps its own profile.`)} more={"Games with their own profile keep it on low battery. Turn on \"Also for games with their own profile\" (Power tab) to save power in them too."} />];
  }
  return [];
}

/** The hardware snapshot has no value yet: "Reading…", or its error with Retry. */
export const hwUnread = (): Element => <Unread what="Hardware" error={hw.error} onRetry={() => hw.invalidate()} />;

/** A knob whose read failed has no control: say why instead (one row each). */
export function knobErrorRows(s: HwSnapshot, knobs: readonly ReadKnob[]): Element[] {
  return knobs.flatMap((k) => {
    const e = s[k].error;
    return e ? [<ErrorRow label={`${fit(KNOB_NAME[k] ?? k, 50)}: not read`} error={explain(e)} />] : [];
  });
}

/** Rules hostd could not apply (profiles.get().active.failed) and the last write's error. */
export function ruleProblems(): Element[] {
  const out: Element[] = [];
  if (!profiles.value && profiles.error) out.push(<ErrorRow label="Power profiles: not read" error={explain(profiles.error)} />);
  if (rulesError) out.push(<ErrorRow label="Power profiles: not saved" error={rulesError} />, <Button label="Retry" icon="refresh" onClick={async () => void (await writeRules())} />);
  for (const f of profiles.value?.active.failed ?? []) {
    const e = explain({ name: "HostError", code: f.code, message: f.message });
    out.push(<Status label={`${KNOB_NAME[f.knob] ?? f.knob} did not apply`} line={e.line} tone="bad" more={[f.message]} />);
  }
  if (lastRules?.left.length) out.push(<Status label={`${lastRules.left.length} game profiles not applied`} line="Bathysphere takes at most 64 rules; the newest profiles go first." tone="warn" />);
  if (rulesOutOfDate()) {
    out.push(
      power.value.enabled
        ? <Button label="Re-apply your power profiles" icon="refresh" onClick={async () => void (await writeRules())} details={details("Re-apply", "Bathysphere's stored rules differ from your profiles (after a reinstall, or a write that did not finish).")} />
        : <Button label="Clear the stored power rules" onClick={() => setEnabled(false)} />,
    );
  }
  return out;
}

/** The toggle and, when refused, which program to turn off first. */
export function enableRows(): Element[] {
  const out: Element[] = [
    <Toggle
      label="Power control"
      description={power.value.enabled ? "Your profiles run, also while OXP3 Deck is closed." : "Off: the device's own defaults."}
      value={power.value.enabled}
      onChange={(v) => setEnabled(v)}
      details={details("Power control", ["Sets boost power, energy preference, CPU limits, the CPU vs GPU balance, the GPU speed range and the fan through the hardware helper, per profile.", "Refused while another program changes the power limits: it lists them, with the commands to turn them off.", "Off writes the device's defaults back (the helper's compiled defaults or this boot's values). Sustained power stays as Steam set it."])}
    />,
  ];
  const still = refused.filter((c) => blocking(conflicts.value, power.value.ignored).some((x) => x.id === c.id));
  if (still.length) out.push(<Status label={`Turn off ${andList(still.map((c) => conflictText(c).name))} first`} line="It also changes the power limits." tone="bad" />);
  if (unchecked) {
    out.push(
      <ErrorRow label="Could not check for other power programs" error={unchecked} />,
      <Button label="Try again" icon="refresh" onClick={() => setEnabled(true)} details={details("Try again", "Reads the other power programs again and turns power control on if none of them changes the power limits. It turns on only once OXP3 Deck could see that.")} />,
    );
  }
  return out;
}

const presetRanges = (s: HwSnapshot) => ({ tdpMin: s.tdp.value!.min, tdpMax: s.tdp.value!.max, boostMin: s.boost.value?.min ?? 0, boostMax: s.boost.value?.max ?? s.tdp.value!.max });

/** A preset tap: its rule part into the edited slot, its Steam part now (Undo for 30 s). */
async function applyPreset(id: PresetId, t: Target, s: HwSnapshot): Promise<void> {
  const row = PRESETS[id];
  const n = presetNumbers(id, presetRanges(s));
  const before = slotValues(power.value.profiles[t.key]!, t.slot);
  const prev = { tdp: s.tdp.value?.watts, cpuBoost: s.cpuBoost.value?.enabled, gpu: s.gpuPowerProfile.value?.profile };
  const eppOk = !!s.epp.value?.available.includes(row.epp);
  await editSlot(t.key, t.slot, { boostW: n.boostW, follow: n.boostW === null ? before.follow : null, epp: eppOk ? row.epp : before.epp, eppP: eppOk ? null : before.eppP, eppE: eppOk ? null : before.eppE, eppLpe: eppOk ? null : before.eppLpe });
  // Steam's own knobs: only for what runs now (they are not per profile)
  const active = activeTarget();
  if (active.key === t.key && active.slot === t.slot) {
    await setTdpNow(n.tdp);
    if (row.cpuBoost !== null && s.cpuBoost.value) await setCpuBoost(row.cpuBoost);
    const want = row.gpuSaving === null ? null : row.gpuSaving ? "power_saving" : "base";
    if (want && s.gpuPowerProfile.value?.available.includes(want)) await setGpuProfile(want);
  }
  offerUndo("preset", `Undo ${PRESET_LABEL[id]}`, async () => {
    await editSlot(t.key, t.slot, before);
    if (prev.tdp !== undefined) await setTdpNow(prev.tdp);
    if (prev.cpuBoost !== undefined) await setCpuBoost(prev.cpuBoost);
    if (prev.gpu) await setGpuProfile(prev.gpu);
  });
}

/** Presets, sustained, boost and the GPU maximum for one slot (the Quick Access Power group). */
export function powerControls(v: View, s: HwSnapshot, t: Target): Element[] {
  const out: Element[] = [];
  const values = slotValues(power.value.profiles[t.key]!, t.slot);
  const tdp = s.tdp.value;
  const boost = s.boost.value;
  out.push(<Text variant="caption" text={`Edits: ${targetName(t)}`} />);
  if (tdp) {
    const which = presetOf(values, tdp.watts, presetRanges(s), !!s.epp.value);
    out.push(
      <Chips
        value={which === "custom" || which === "default" ? "custom" : which}
        options={[...PRESET_IDS.map((id) => ({ value: id, label: PRESET_LABEL[id] })), { value: "custom", label: which === "default" ? "Default" : "Custom" }]}
        onChange={(id) => (id === "custom" ? undefined : applyPreset(id as PresetId, t, s))}
      />,
    );
    const undo = undoLabel("preset");
    if (undo) out.push(<ListItem label={undo} description="For 30 s: puts back the values before the preset." onClick={() => runUndo("preset")} icon="refresh" />);
    const w = clampIn(drafts.get("tdp") ?? tdp.watts, tdp.min, tdp.max);
    out.push(
      <Slider
        label="Sustained power"
        min={tdp.min}
        max={tdp.max}
        step={1}
        value={w}
        valueLabel={`${w} W`}
        onChange={(x) => setTdp(x)}
        details={details("Sustained power (Steam's TDP)", ["The power the CPU and GPU may use over time. This is Steam's own setting (Quick Access → Performance); Steam's per-game profile keeps it per game.", tdp.capped === "battery" ? `On battery it runs at ${tdp.effective} W.` : null, `Range on this device: ${tdp.min}–${tdp.max} W.`])}
      />,
    );
    out.push(<ErrorRow error={writeErrors.get("tdp")} />);
    if (tdp.capped === "battery") out.push(<Text variant="caption" text={`Runs at ${tdp.effective} W on battery`} />);
  }
  if (boost && boost.modes.includes("manual")) {
    const floor = Math.max(boost.min, tdp?.watts ?? boost.min);
    if (floor < boost.max) {
      const shown = clampIn(values.boostW ?? boost.effective, floor, boost.max);
      out.push(
        <Slider
          label="Boost power"
          min={floor}
          max={boost.max}
          step={1}
          value={shown}
          valueLabel={values.boostW === null ? (values.follow ? `follows (${boost.effective} W)` : `device (${boost.effective} W)`) : `${shown} W`}
          onChange={(x) => debounce(`boost:${v.key}`, 400, () => void editSlot(t.key, t.slot, { boostW: x, follow: null }))}
          details={details("Boost power (PL2)", ["The short bursts above sustained power. Never below sustained power: the helper keeps them in order.", `Range: ${boost.min}–${boost.max} W. The device's own value is ${boost.max} W.`])}
        />,
      );
    }
  }
  const gr = s.gpuRange.value;
  if (gr && gr.ceilMhz > gr.floorMhz) {
    const max = clampIn(values.gpuMaxMhz ?? gr.maxMhz, gr.floorMhz, gr.ceilMhz);
    {
      out.push(
        <Slider
          label="GPU maximum speed"
          min={gr.floorMhz}
          max={gr.ceilMhz}
          step={50}
          value={snap(max, gr.floorMhz, gr.ceilMhz, 50)}
          valueLabel={values.gpuMaxMhz === null ? `device (${gr.maxMhz} MHz)` : `${max} MHz`}
          onChange={(x) => debounce(`gpuMax:${v.key}`, 400, () => void editSlot(t.key, t.slot, { gpuMaxMhz: Math.max(x, values.gpuMinMhz ?? gr.floorMhz) }))}
          details={details("GPU maximum speed", ["The GPU's upper clock while Steam's GPU clock setting is off. Steam's manual GPU clock overrides this range.", `Range: ${gr.floorMhz}–${gr.ceilMhz} MHz.`])}
        />,
      );
    }
  }
  return out;
}

/** Steadier fps after loads, GPU minimum speed and Reset (the panel). */
export function powerExtras(v: View, s: HwSnapshot, t: Target): Element[] {
  const out: Element[] = [];
  const values = slotValues(power.value.profiles[t.key]!, t.slot);
  if (s.boost.value?.modes.includes("follow")) {
    out.push(
      <Toggle
        label="Steadier fps after loads"
        description="Boost follows sustained power (+25 %, +50 % plugged in)."
        value={values.follow === true && values.boostW === null}
        onChange={(on) => editSlot(t.key, t.slot, on ? { follow: true, boostW: null } : { follow: null })}
        details={details("Steadier fps after loads", ["Boost stays a little above sustained power instead of the device's 52 W, so frame rates drop less when a load ends. The helper's follow mode adds a fixed number of watts: OXP3 Deck picks a quarter of sustained power (a half plugged in) when it writes the profile, so it does not change when Steam's sustained power changes later."])}
      />,
    );
    if (values.boostW !== null || values.follow) out.push(<Button label="Boost: use the device's value" onClick={() => editSlot(t.key, t.slot, { boostW: null, follow: null })} />);
  }
  const gr = s.gpuRange.value;
  if (gr && gr.ceilMhz > gr.floorMhz) {
    const maxNow = values.gpuMaxMhz ?? gr.maxMhz;
    const min = clampIn(values.gpuMinMhz ?? gr.minMhz, gr.floorMhz, Math.max(gr.floorMhz, maxNow));
    out.push(
      <Slider
        label="GPU minimum speed"
        min={gr.floorMhz}
        max={gr.ceilMhz}
        step={50}
        value={snap(min, gr.floorMhz, gr.ceilMhz, 50)}
        valueLabel={values.gpuMinMhz === null ? `device (${gr.minMhz} MHz)` : `${min} MHz`}
        onChange={(x) => debounce(`gpuMin:${v.key}`, 400, () => void editSlot(t.key, t.slot, { gpuMinMhz: Math.min(x, maxNow) }))}
        details={details("GPU minimum speed", "A higher floor keeps the GPU from clocking down between frames; it costs battery. Never above the maximum.")}
      />,
    );
  }
  out.push(
    <Button
      label="Reset to device defaults"
      onClick={async () => {
        const ok = await host.ui.confirm({ title: "Reset to device defaults?", body: `Every power value of ${targetName(t)} goes back to the device's own (the fan stays as it is).`, ok: "Reset" });
        if (ok) await resetSlot(t.key, t.slot);
      }}
    />,
  );
  return out;
}

/** A select holds at most this many options (SPEC §6.2). */
const MAX_OPTIONS = 64;

/** The profiles to pick from: Default, then the games by name, at most 64, always with the one edited. */
function profileChoices(edited: string): string[] {
  const name = (k: string) => (power.value.profiles[k]?.name ?? appName(Number(k))).toLowerCase();
  const games = Object.keys(power.value.profiles)
    .filter((k) => k !== "default")
    .sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : Number(a) - Number(b)));
  const keys = ["default", ...games].slice(0, MAX_OPTIONS);
  if (!keys.includes(edited)) keys[keys.length - 1] = edited;
  return keys;
}

/** The panel's profile editor: which profile and slot the controls edit. */
export function editorRows(v: View): { target: Target; rows: Element[] } {
  const running = currentGame();
  const t = stateOf<Target>(v, "edit", activeTarget());
  if (!power.value.profiles[t.key]) Object.assign(t, { key: "default", slot: "main" });
  const name = (k: string) => (k === "default" ? "Default" : (power.value.profiles[k]?.name ?? appName(Number(k))));
  const label = (k: string) => `${name(k)}${Number(k) === running ? " (running)" : ""}`;
  const rows: Element[] = [
    <Select
      label="Profile to edit"
      options={profileChoices(t.key).map((k) => ({ value: k, label: fit(label(k), 60) }))}
      value={t.key}
      onChange={(k) => setState(v, "edit", { key: k, slot: "main" })}
    />,
  ];
  const slots: Array<{ value: Slot; label: string }> = [{ value: "main", label: power.value.options.splitAc ? "On battery" : "Always" }];
  if (power.value.options.splitAc) slots.push({ value: "ac", label: "Plugged in" });
  if (t.key === "default" && power.value.options.lowBattery) slots.push({ value: "low", label: "Low battery" });
  if (slots.length > 1) rows.push(<Chips value={slots.some((x) => x.value === t.slot) ? t.slot : "main"} options={slots} onChange={(x) => setState(v, "edit", { key: t.key, slot: x })} />);
  if (t.key !== "default") {
    rows.push(
      <Button
        label="Delete this game's profile"
        variant="danger"
        onClick={async () => {
          const ok = await host.ui.confirm({ title: dialogTitle("Delete the profile of ", name(t.key), "?"), body: `${name(t.key)} then uses the Default profile.`, ok: "Delete", destructive: true });
          if (ok) {
            await setGameProfile(Number(t.key), name(t.key), false);
            setState(v, "edit", { key: "default", slot: "main" });
          }
        }}
      />,
    );
  }
  const games = (library.value ?? []).filter((a) => !power.value.profiles[String(a.appid)]).slice(0, MAX_OPTIONS - 1);
  if (games.length) {
    rows.push(
      <Select
        label="New profile for a game"
        options={[{ value: "", label: "Pick a game" }, ...games.map((a) => ({ value: String(a.appid), label: fit(a.name, 60) }))]}
        value=""
        onChange={async (k) => {
          if (!k) return;
          await setGameProfile(Number(k), appName(Number(k)), true);
          setState(v, "edit", { key: k, slot: "main" });
        }}
      />,
    );
  }
  return { target: { key: t.key, slot: slots.some((x) => x.value === t.slot) ? t.slot : "main" }, rows };
}

/** Power options: per-game profiles, plugged-in values, the plugged-in limit card, low battery. */
export function optionRows(s: HwSnapshot | undefined, acLine: string | null): Element[] {
  const o = power.value.options;
  const tdp = s?.tdp.value;
  return [
    <Toggle label="Per-game profiles" description="A game with its own profile uses it while it runs." value={o.perGame} onChange={(x) => setOptions({ perGame: x })} />,
    <Toggle label="Different settings when plugged in" description="Each profile gets plugged-in values (sustained power stays Steam's)." value={o.splitAc} onChange={(x) => setOptions({ splitAc: x })} />,
    <Status label="Allow up to 52 W when plugged in" line={acLine ?? (tdp ? `Steam's sustained power goes up to ${tdp.max} W now.` : "Needs the hardware helper.")} more="The helper keeps 35 W on battery. An administrator file can allow more sustained power on the charger (up to 52 W; above 40 W use a 65 W charger or stronger). The card shows the steps; this row reads the file back." />,
    <Card id="hw-ac-limit" />,
    <Toggle label="Save power on low battery" description={`Below ${o.lowPct} % on battery, use the low-battery values.`} value={o.lowBattery} onChange={(x) => setOptions({ lowBattery: x })} details={details("Save power on low battery", ["Below the level on battery the low-battery values run (by default the Battery preset's boost and energy preference), each limit the lower of the profile's and the low values. Bathysphere ends them when you plug in, or once the battery is back at 2 % above the level.", "A game with its own profile keeps it unless \"Also for games with their own profile\" is on.", "Sustained power is Steam's own setting and cannot be lowered automatically."])} />,
    ...(o.lowBattery
      ? [
          <Slider label="Low battery level" min={LOW_SLIDER.min} max={LOW_SLIDER.max} step={LOW_SLIDER.step} value={o.lowPct} valueLabel={`${o.lowPct} %`} onChange={(x) => debounce("lowPct", 400, () => void setOptions({ lowPct: x }))} />,
          <Toggle label="Also for games with their own profile" value={o.lowGames} onChange={(x) => setOptions({ lowGames: x })} />,
        ]
      : []),
  ];
}

/** Live readouts (the panel adds GPU clocks). */
export function liveRowsView(v: View, gpuClocks: boolean): Element[] {
  liveViews.set(v.key, { gpuClocks });
  const sample = lastSample();
  const rows = liveRows(sample);
  if (!rows.length) return [<Text variant="muted" text="Reading…" />];
  const out = rows.map((r) => <Field label={r.label} value={r.value} />);
  const gpu = reasonText(sample?.s.gpu?.reasons);
  if (gpu) out.push(<Status label="GPU held back" line={gpu} tone="warn" />);
  out.push(<Status label="Where these come from" more={LIVE_SOURCES} />);
  return out;
}

/** Ranges of this device (from the knobs' gets) and the provider. */
export function rangeRows(s: HwSnapshot): Element[] {
  const lines: string[] = [];
  const t = s.tdp.value;
  if (t) lines.push(`Sustained power: ${t.min}–${t.max} W`);
  const b = s.boost.value;
  if (b) lines.push(`Boost power: ${b.min}–${b.max} W (follow offset up to ${b.offsetMax} W)`);
  const g = s.gpuRange.value;
  if (g) lines.push(`GPU speed: ${g.floorMhz}–${g.ceilMhz} MHz`);
  const c = s.cpuLimits.value;
  if (c) lines.push(`CPU speed cap: ${c.maxPerfPctMin}–100 %`, ...Object.entries(c.coreTypeRange).map(([k, [lo, hi]]) => `${k} cores: ${lo}–${hi} MHz`));
  const sb = s.socBalance.value;
  if (sb) lines.push(`CPU vs GPU balance: ${sb.balanceMin}–${sb.balanceMax}, offset 0–${sb.offsetMax}`);
  const p = s.state.provider;
  return [<Status label="This device's ranges" line={p ? `${p.name} ${p.version} · ${p.state}` : "No hardware helper"} more={["The helper refuses anything outside these; nothing is ever clamped. The defaults it restores and their sources are in Bathysphere Home → Hardware."]} lines={lines} />];
}

/** Values the device check could not put back because OXP3 Deck closed, with Put back. */
export function owedRows(): Element[] {
  const what = owedText();
  if (!what.length) return [];
  return [
    <Status label="The device check did not put everything back" line={`Not put back: ${andList(what)}.`} tone="bad" more="OXP3 Deck was closed during the check. Every hardware change needs an open OXP3 Deck surface, so the check stopped there. While a surface is open, OXP3 Deck puts the value back by itself within a minute; Put back does it now." />,
    <Button label="Put back" icon="refresh" onClick={() => putBackOwed()} />,
  ];
}

/** The device check, the 60 s measurement and their results. */
export function checkRows(): Element[] {
  const out: Element[] = [...owedRows()];
  const st = selftest.value;
  if (task.running) out.push(<Status label={task.title ?? "Working…"} line={task.log[task.log.length - 1] ?? "Started"} lines={task.log.slice(-32)} />);
  out.push(
    <Button
      label="Check this device"
      disabled={task.running}
      onClick={async () => {
        if (anyRunning()) {
          await host.ui.details({ title: "Device check", body: "Quit the game first: the check changes power limits for a moment." });
          return;
        }
        const ok = await host.ui.confirm({ title: "Check this device?", body: "Moves each power control a small step, reads it back and puts it back, one at a time (about 20 s). Fan and charging are not touched.", ok: "Check" });
        // the check runs on after the handler (it takes longer than a UI event may); its row shows progress
        if (ok) void runCheck(anyRunning());
      }}
    />,
  );
  if (st.test) {
    const l = checkLine(st.test);
    out.push(<Status label="Device check" line={l.line} tone={l.bad ? "bad" : "neutral"} lines={st.test.probes.map(probeLine)} />);
  }
  out.push(
    <Button
      label={anyRunning() ? "Measure this game for 60 s" : "Measure idle power for 60 s"}
      disabled={task.running}
      onClick={() => {
        const g = currentGame();
        void runMeasure(g === null ? null : { appid: g, name: appName(g) });
      }}
    />,
  );
  for (const m of st.measures.slice(0, 3)) out.push(<Status label={fit(measureLine(m))} more={[`${m.seconds} s · ${m.ac === null ? "power source unknown" : m.ac ? "plugged in" : "battery"}`, `CPU thermal throttling: ${m.cpuThrottleMs ?? "?"} ms`, `GPU throttle reasons: ${Object.entries(m.reasons).map(([k, x]) => `${k} ${Math.round(x * 100)} %`).join(", ") || "none"}`, m.stopped ? `Stopped early: ${m.stopped}` : null]} />);
  return out;
}

/** The AC limit file the hw-ac-limit card writes (read back for that row). */
export async function acLimitLine(): Promise<string | null> {
  try {
    const t = await host.fs.system.read("/etc/oxp3-hw/limits.toml", { maxBytes: 65536 });
    const m = /^\s*sustained_ac_max_w\s*=\s*(\d+)/m.exec(t);
    return m ? `limits.toml allows ${m[1]} W plugged in.` : "limits.toml exists; sustained_ac_max_w is not set.";
  } catch {
    return null;
  }
}

