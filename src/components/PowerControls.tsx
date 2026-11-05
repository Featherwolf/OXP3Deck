// Power control (DESIGN.md "Power (TDP, GPU, CPU)", Frontend): the rows the quick panel's Power section and the full
// page's Power tab share. Profile values go through the store's one writer (powerWriter), never straight to
// power_set, so a slider drag reaches the backend in order and a late answer cannot move a slider back. Every row
// shows one plain line; the rest is in its Details (☰).
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { FC, useEffect, useMemo, useRef, useState } from "react";

import { useAction } from "../actions";
import { power_enable, power_info, power_profile, power_take_control } from "../backend";
import { friendlyName, lockedLine } from "../conflicts";
import { EFFECTS } from "../effects";
import {
  blockers, capRows, clampW, cpuNowLine, editSlot, EMPTY, eppOptions, GOVERNOR_PERFORMANCE, RESET, fwValues, gpuNotches,
  limitsLine, pl1Change, pl2Floor, profileLine, reasonText, shown, Slot, suspects, watts, yieldedText,
} from "../power";
import { RunningApp } from "../steam";
import { invalidate, notePower, powerWriter, usePowerErrors, usePowerState, useResource } from "../store";
import { firstSentence } from "../text";
import type {
  Epp, ExtrasState, PowerChangeRes, PowerConflict, PowerInfo, PowerInfoRes, PowerState, PowerValues,
} from "../types";
import { listText, remember } from "../util";
import { clearRecentFixes, ConflictRows, FixedRows } from "./ConflictRow";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { CpuControls } from "./CpuControls";
import { ChargeRows, ProfileExtras, useExtrasState } from "./ExtrasControls";
import { explainWhen, label, Problem, Status, WithDetails } from "./Hint";
import { useQuickAccessVisible } from "./JobView";
import { LiveRow } from "./LiveRows";

/** The cached power info and the live state (polled only while `active`): the state of power_state, else info's. */
export const usePower = (active: boolean) => {
  const info = useResource<PowerInfoRes>("power-info", () => power_info(false));
  const live = usePowerState(active);
  const i = info.data?.ok ? info.data.info : null;
  const state = (live.data?.ok ? live.data.state : null) ?? i?.state ?? null;
  // the conflict rows the guidance is built from: reload them when a blocker or an override shows up (or leaves)
  const watch = `${state?.blocked ?? ""}|${state?.overridden?.since ?? ""}|${(state?.cpu_blocked_by ?? []).join(",")}`;
  const seen = useRef(watch);
  useEffect(() => {
    if (seen.current === watch) return;
    seen.current = watch;
    invalidate("power-info");
  }, [watch]);
  return { info: i, state, error: info.data && !info.data.ok ? info.data.error : null, reloadInfo: info.reload };
};

/** A change call's answer into the caches; its error text (or null). */
export const settle = (r: PowerChangeRes): string | null => notePower(r);

const names = (cs: PowerConflict[]) => listText(cs.map((c) => friendlyName(c.id, c.name)));

/** The conflicts behind cpu_blocked (cpu_blocked_by; an older backend: every cpu conflict not handled). */
export const cpuBlockers = (state: PowerState, info: PowerInfo | null): PowerConflict[] => {
  if (!state.cpu_blocked) return [];
  const all = info?.conflicts ?? [];
  const by = state.cpu_blocked_by ?? [];
  return by.length ? all.filter((c) => by.includes(c.id)) : all.filter((c) => c.kind === "cpu" && !c.ignored);
};

const statusDetails = (state: PowerState): DetailsSpec => {
  const n = state.now;
  const why = reasonText(n.gpu?.reasons);
  return {
    title: "Power now",
    body: paragraphs([
      "Steady is the power the CPU and GPU share for as long as a game runs; boost is the short burst above it.",
      n.gpu ? `GPU at ${n.gpu.act ?? "?"} MHz (allowed ${n.gpu.min ?? "?"}–${n.gpu.max ?? "?"} MHz)${why ? `, ${why}` : ", running freely"}.` : null,
      state.enabled ? `Profile: ${profileLine(state)}.` : "Power control is off: these are the device's own limits.",
    ]),
    lines: [
      ...n.zones.map((z) => `${z.iface.toUpperCase()} ${z.name}: PL1 ${watts(z.pl1_w)} · PL2 ${watts(z.pl2_w)} · PL4 ${watts(z.pl4_w)}${z.locked.length ? ` (locked: ${z.locked.join(", ")})` : ""}`),
      ...(n.gpu?.reasons.length ? [`GPU throttle reasons: ${n.gpu.reasons.join(", ")}`] : []),
    ],
  };
};

const TAKE_D: DetailsSpec = {
  title: "Take control again",
  body: "Writes this profile's values again and watches them as before. Turn the other program off first, or it changes them back.",
};

/** The status line and the red rows: blocked, overridden (with "Take control again"), what did not take. */
export const PowerStatusRows: FC<{ info: PowerInfo | null; state: PowerState; quick?: boolean }> = ({ info, state, quick }) => {
  const act = useAction();
  const o = state.overridden;
  const caps = capRows(state.last, state.now.zones);
  const blocking = blockers(info?.conflicts);
  const gpuHeld = state.enabled && (state.now.gpu?.reasons ?? []).some((r) => /^(pl\d|power|vr_tdc)$/.test(r));
  const sus = o ? suspects(o, info?.conflicts) : [];
  const ignoredOwner = listText((info?.conflicts ?? []).filter((c) => c.kind === "cpu" && c.ignored).map((c) => friendlyName(c.id, c.name))) || "another program";
  const yielded = yieldedText(state.yielded, ignoredOwner);
  const susNames = (o?.suspects ?? []).map((id) => (id === "steam" ? "Steam's own sliders" : id === "other" ? "another program"
    : friendlyName(id, info?.conflicts.find((c) => c.id === id)?.name)));
  return (
    <>
      <PanelSectionRow>
        <Status ok={!state.enabled ? null : !o && !state.blocked}
          label={limitsLine(state)} details={statusDetails(state)}
          detail={state.enabled ? `${profileLine(state)}${gpuHeld ? " · GPU held back by power limit" : ""}` : "Device defaults"} />
      </PanelSectionRow>
      {state.enabled && state.blocked && (
        <PanelSectionRow>
          <Status ok={false} red label="Power control paused"
            detail={`${names(blocking) || "Another program"} is also changing power limits.`}
            details={{ title: "Power control paused", body: paragraphs([state.blocked, "OXP3 Deck writes nothing while another program changes the power limits. Turn it off (Fix for me where offered), and power control picks up again."]) }} />
          <ConflictRows rows={blocking} info={info} quick={quick} />
        </PanelSectionRow>
      )}
      {state.enabled && o && (
        <PanelSectionRow>
          <Status ok={false} red label="Something changed your power limits"
            detail={susNames.length ? `Likely ${listText(susNames)}. Fix it, then tap Take control again.` : "Fix it, then tap Take control again."}
            details={{
              title: "Something changed your power limits",
              body: paragraphs([`Now ${o.now}; OXP3 Deck set ${o.ours}. OXP3 Deck stops writing instead of fighting the other program.`,
                ...sus.filter((s) => s.fix).map((s) => `${s.name}: ${s.fix}`)]),
            }} />
          <WithDetails details={TAKE_D}>
            <ButtonItem layout="below" disabled={!!act.busy}
              onClick={() => act.run("take", async () => { await powerWriter.drain(); return settle(await power_take_control()); })}
              description={explainWhen("Re-applies your settings.", EFFECTS["power.take_control"])}>
              {act.busy ? "Working…" : label("Take control again", TAKE_D)}
            </ButtonItem>
          </WithDetails>
          <Problem what="Take control" error={act.error} />
        </PanelSectionRow>
      )}
      {state.enabled && state.now.governor === "performance" && (
        <PanelSectionRow>
          <Status ok={false} red label={GOVERNOR_PERFORMANCE.label} detail={GOVERNOR_PERFORMANCE.line}
            details={{ title: GOVERNOR_PERFORMANCE.label, body: paragraphs([GOVERNOR_PERFORMANCE.detail,
              "With this policy the kernel holds every core at its top allowed speed: the CPU speed cap still works, energy preference cannot change and the minimum speed equals the cap. Another tool (SimpleDeckyTDP's governor setting, for example) set it; OXP3 Deck does not change it."]),
              lines: ["cpufreq scaling_governor: performance (OXP3 Deck expects powersave with intel_pstate active)"] }} />
        </PanelSectionRow>
      )}
      {state.enabled && yielded && (
        <PanelSectionRow>
          <Status ok={false} label="Left to another program" detail={yielded}
            details={{ title: "Left to another program", body: paragraphs([
              `${yielded} You set ${ignoredOwner} to be ignored, and it changed this again (power-profiles-daemon does on a power mode or charger change).`,
              "OXP3 Deck leaves it instead of fighting; every other setting, the power limits too, keeps applying. Your value is written again at your next change, or turn the program off with Fix for me under Other power programs.",
            ]) }} />
        </PanelSectionRow>
      )}
      {state.enabled && caps.length > 0 && (
        <PanelSectionRow>
          {caps.map((c, n) => (
            <Status key={n} ok={false} label={c.label} detail={c.line ?? firstSentence(c.detail)}
              details={{ title: c.label, body: paragraphs([c.detail, "The CPU uses the lower of its two power-limit interfaces, so a capped one sets the limit."]) }} />
          ))}
        </PanelSectionRow>
      )}
      {/* the Power tab lists every record under "Other power programs"; the quick panel only what it just fixed */}
      {quick && <PanelSectionRow><FixedRows info={info} quick /></PanelSectionRow>}
    </>
  );
};

const ENABLE_SEEN = "powerEnableConfirmed";

const ENABLE_DETAILS: DetailsSpec = {
  title: "Power control (TDP)",
  body: paragraphs([
    "On: OXP3 Deck sets the power limits, GPU speed and CPU boost from the active profile, and sets them again after sleep, when a game starts and when the charger is plugged in or out.",
    "Off: the device's own limits apply. Turning it off, or rebooting, restores them.",
    "Turn it off before you disable or uninstall OXP3 Deck: otherwise the GPU speed range and energy preference it set stay until a reboot.",
  ]),
  lines: ["RAPL PL1 (long_term) and PL2 (short_term), MSR and MMIO", "xe render GT min_freq / max_freq",
    "cpufreq energy_performance_preference, intel_pstate no_turbo"],
};

/** The "Power control (TDP)" toggle: the first enable asks first; a refused one lists each blocking conflict and its fix. */
export const EnableToggle: FC<{ state: PowerState; info: PowerInfo | null; quick?: boolean }> = ({ state, info, quick }) => {
  const act = useAction();
  const [refused, setRefused] = useState<PowerConflict[]>([]);
  const r = state.range;
  const rangeText = r.spec === "oxp3"
    ? `${r.pl1_min}–${r.pl1_max_battery} W on battery, up to ${r.pl1_max_ac} W plugged in`
    : `${r.pl1_min}–${r.pl1_max} W (this device's own limits)`;
  const toggle = (on: boolean) => act.run("enable", async () => {
    setRefused([]);
    if (on && remember.get(ENABLE_SEEN) !== "1") {
      const ok = await confirm({
        title: "Turn on power control?", ok: "Turn on", effect: EFFECTS["power.enable"],
        text: (
          <>
            <div>OXP3 Deck will set power limits, GPU speed and CPU boost from your profile. Nothing changes until you move a
              slider. Turning it off, or rebooting, restores the defaults.</div>
            <div style={{ marginTop: 8 }}>Allowed: {rangeText}.</div>
          </>
        ),
        linesTitle: "Technical:",
        lines: ["Writes PL1 (sustained) and PL2 (boost) to both RAPL interfaces (MSR and MMIO).",
          "Writes the Arc GPU's min/max clock and the CPU's EPP and turbo.",
          "Fields left at \"device default\" keep the values the system booted with."],
      });
      if (!ok) return null;
      remember.set(ENABLE_SEEN, "1");
    }
    await powerWriter.drain();
    const res = await power_enable(on);
    if (!res.ok && res.conflicts?.length) setRefused(blockers(res.conflicts).length ? blockers(res.conflicts) : res.conflicts);
    return settle(res);
  });
  const problems = info?.hw.problems ?? [];
  const noRapl = !state.enabled && info !== null && !info.hw.rapl && !info.hw.mmio;
  // a refused enable: the rows from the fresh power-info once it has them (a fix there updates them), else the answer's
  const live = refused.map((c) => info?.conflicts.find((x) => x.id === c.id) ?? c)
    .filter((c) => info?.conflicts.some((x) => x.id === c.id) || !(info?.fixed ?? []).some((f) => f.id === c.id));
  return (
    <PanelSectionRow>
      <WithDetails details={ENABLE_DETAILS}>
        <ToggleField label={label("Power control (TDP)", ENABLE_DETAILS)} checked={state.enabled}
          disabled={!!act.busy || noRapl}
          onChange={toggle}
          description={explainWhen(state.enabled ? "Uses your profile below." : "Device defaults. Turn on to set power here.",
            EFFECTS["power.enable"], noRapl ? "This system doesn't expose power limits." : null)} />
      </WithDetails>
      {problems.length > 0 && (
        <Status ok={false} label="Power control unavailable" detail={firstSentence(problems[0])}
          details={{ title: "Power control unavailable", body: paragraphs(problems) }} />
      )}
      {live.length > 0 && <Status ok={false} red label={`Turn off ${names(live)} first`} />}
      <ConflictRows rows={live} info={info} quick={quick} />
      <Problem what="Power control" error={act.error} />
    </PanelSectionRow>
  );
};

/** Values typed by the user that the stored profile does not show yet (an answer still on its way). */
export const useDraft = (key: string, slot: Slot, stored: PowerValues) => {
  const [draft, setDraft] = useState<Partial<PowerValues>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft({}); setError(null); }, [key, slot]);
  // a draft value the stored one has caught up with is done
  useEffect(() => {
    setDraft((d) => {
      const left = Object.fromEntries(Object.entries(d).filter(([f, v]) => stored[f as keyof PowerValues] !== v));
      return Object.keys(left).length === Object.keys(d).length ? d : left;
    });
  }, [JSON.stringify(stored)]);
  usePowerErrors((e) => { setDraft({}); setError(e); });
  const write = (values: Partial<PowerValues>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...values }));
    powerWriter.write(key, slot, values);
  };
  return { values: { ...stored, ...draft } as PowerValues, write, error, clearError: () => setError(null) };
};

const dflt = (isNull: boolean) => (isNull ? " (device default)" : "");

const TURBO_OPTIONS = [{ data: "fw", label: "Device default" }, { data: "on", label: "On" }, { data: "off", label: "Off" }];

/** Details of one slider or choice: the plain body, then its technical name. */
const det = (title: string, body: (string | null | undefined | false)[], lines?: string[]): DetailsSpec =>
  ({ title, body: paragraphs(body), lines });

/**
 * The sliders and choices of one profile slot. quick: sustained, boost, GPU max and CPU boost only. `active`: the
 * slot runs now, so null fields show the applied firmware values; otherwise the boot values.
 */
export const ValuesEditor: FC<{
  state: PowerState; info: PowerInfo | null; profileKey: string; slot: Slot; stored: PowerValues; active: boolean;
  label: string; quick?: boolean;
}> = ({ state, info, profileKey, slot, stored, active, label: what, quick }) => {
  const d = useDraft(profileKey, slot, stored);
  const v = d.values;
  const r = state.range;
  const sh = shown(v, active ? shown(state.applied_values, fwValues(state)) : fwValues(state));
  const pl1 = clampW(sh.pl1_w ?? r.pl1_min, r);
  const pl2Min = pl2Floor(pl1, r);
  const pl2Max = Math.max(pl2Min, Math.floor(r.pl2_max));
  const pl2 = Math.min(pl2Max, Math.max(pl2Min, Math.round(sh.pl2_w ?? pl2Max)));
  const gpu = r.gpu_min != null && r.gpu_max != null && r.gpu_max > r.gpu_min ? { lo: r.gpu_min, hi: r.gpu_max } : null;
  const gpuClamp = (x: number | null, dd: number) => (gpu ? Math.min(gpu.hi, Math.max(gpu.lo, x ?? dd)) : 0);
  const gmax = gpuClamp(sh.gpu_max_mhz, gpu?.hi ?? 0);
  const gmin = gpuClamp(sh.gpu_min_mhz, gpu?.lo ?? 0);
  const notches = useMemo(() => gpuNotches(r), [r.gpu_min, r.gpu_max, r.gpu_efficient]);
  const cpu = info?.hw.cpu ?? null;
  const lockers = cpuBlockers(state, info);
  const cpuOff = state.cpu_blocked;
  const lockText = lockedLine(lockers.map((c) => friendlyName(c.id, c.name)));
  const where = `Edits ${what}.${active ? "" : " Saved now; used when this profile is active."}`;
  const over = v.pl1_w != null && v.pl1_w > r.pl1_max ? `Saved ${v.pl1_w} W; runs at ${r.pl1_max} W now (the limit ${state.active.ac ? "plugged in" : "on battery"}).` : null;
  const fwv = fwValues(state);
  const pl1D = det("Sustained power", ["The power the CPU and GPU share for as long as a game runs. Higher is faster; the battery lasts less.", where, over,
    fwv.pl1_w != null ? `Device default: ${watts(fwv.pl1_w)}.` : null], ["PL1 (RAPL long_term), MSR and MMIO"]);
  const pl2D = det("Boost power", [`A short burst above sustained power, for a few seconds. Up to ${r.pl2_max} W; never below sustained power.`,
    fwv.pl2_w != null ? `Device default: ${watts(fwv.pl2_w)}.` : null], ["PL2 (RAPL short_term), MSR and MMIO"]);
  const gminD = det("GPU minimum speed", ["The graphics chip never runs slower than this. Higher costs battery even when idle; useful only if one game stutters from speed dips.",
    gpu ? `Device default: ${gpu.lo} MHz.` : null], ["xe render GT min_freq"]);
  const gmaxD = det("GPU maximum speed", ["The graphics chip never runs faster than this. Lower saves battery and leaves more of the power to the CPU.",
    r.gpu_efficient ? `${r.gpu_efficient} MHz is its most efficient speed.` : null, gpu ? `Device default: ${gpu.hi} MHz.` : null], ["xe render GT max_freq"]);
  const eppD = det("Energy preference", [
    "How eagerly the CPU speeds up: Performance is fastest, Power saving makes the battery last longest. Device default: as it booted.",
    state.now.governor === "performance" ? "The CPU's speed policy is set to performance, so energy preference cannot change. OXP3 Deck does not change that policy." : null,
    cpuOff ? lockText : null,
  ], ["energy_performance_preference (EPP), every cpufreq policy"]);
  const turboD = det("CPU boost", ["Lets the CPU run above its base speed. Off saves battery in light games; most games run slower without it.",
    cpuOff ? lockText : null], ["intel_pstate no_turbo"]);
  // the lockers with their Fix for me; once fixed, its "… is off" + Undo right here (the quick panel lists those below)
  const cpuRows = cpuOff && lockers.length > 0 ? <ConflictRows rows={lockers} info={info} quick={quick} />
    : !quick ? <FixedRows info={info} quick cpu /> : null;
  const resetD = det("Reset to device defaults", [`Every value of ${what} goes back to the device's own.`, active ? "Applies at once." : "Saved now; used when this profile is active."]);
  return (
    <>
      {state.blocked && (
        <PanelSectionRow>
          <Status ok={false} label="Paused" detail="Changes are saved and apply once the other program stops."
            details={det("Paused", [state.blocked, "Power control is paused while another program changes the power limits. Changes here are saved in the profile and written as soon as it stops (Fix for me under Power control paused)."])} />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <WithDetails details={pl1D}>
          <SliderField label={label("Sustained power", pl1D)} value={pl1} min={r.pl1_min} max={Math.max(r.pl1_min, r.pl1_max)} step={1}
            showValue valueSuffix=" W" editableValue={!quick}
            onChange={(x) => d.write(pl1Change(clampW(x, r), pl2))}
            description={explainWhen(`Steady power for CPU and GPU. Higher is faster, battery shorter.${dflt(v.pl1_w === null)}`, EFFECTS["power.pl1"])} />
        </WithDetails>
      </PanelSectionRow>
      <PanelSectionRow>
        <WithDetails details={pl2D}>
          <SliderField label={label("Boost power", pl2D)} value={pl2} min={pl2Min} max={pl2Max} step={1} disabled={pl2Max <= pl2Min}
            showValue valueSuffix=" W" editableValue={!quick}
            onChange={(x) => d.write({ pl2_w: Math.min(pl2Max, Math.max(pl2Min, Math.round(x))) })}
            description={explainWhen(`Short bursts above sustained power.${dflt(v.pl2_w === null)}`, EFFECTS["power.pl2"],
              pl2Max <= pl2Min ? "Sustained power is at the maximum." : null)} />
        </WithDetails>
      </PanelSectionRow>
      {gpu && !quick && (
        <PanelSectionRow>
          <WithDetails details={gminD}>
            <SliderField label={label("GPU minimum speed", gminD)} value={gmin} min={gpu.lo} max={gpu.hi} step={50} showValue valueSuffix=" MHz"
              {...notches} notchTicksVisible={false}
              onChange={(x) => d.write(x > gmax ? { gpu_min_mhz: x, gpu_max_mhz: x } : { gpu_min_mhz: x })}
              description={explainWhen(`Raise only if one game stutters from GPU dips.${dflt(v.gpu_min_mhz === null)}`, EFFECTS["power.gpu_min"])} />
          </WithDetails>
        </PanelSectionRow>
      )}
      {gpu && (
        <PanelSectionRow>
          <WithDetails details={gmaxD}>
            <SliderField label={label("GPU maximum speed", gmaxD)} value={gmax} min={gpu.lo} max={gpu.hi} step={50} showValue valueSuffix=" MHz"
              {...notches} notchTicksVisible={false}
              onChange={(x) => d.write(x < gmin ? { gpu_max_mhz: x, gpu_min_mhz: x } : { gpu_max_mhz: x })}
              description={explainWhen(`Lower saves battery and leaves more power for the CPU.${dflt(v.gpu_max_mhz === null)}`, EFFECTS["power.gpu_max"])} />
          </WithDetails>
        </PanelSectionRow>
      )}
      <CpuControls state={state} info={info} v={v} write={d.write} active={active} quick={quick} />
      {!quick && cpu && cpu.epp_choices.length > 0 && (
        <PanelSectionRow>
          <WithDetails details={eppD}>
            <DropdownItem label={label("Energy preference", eppD)} disabled={!!cpuOff}
              rgOptions={eppOptions(cpu.epp_choices)} selectedOption={v.epp}
              onChange={(o) => d.write({ epp: o.data as Epp | null })}
              description={explainWhen("How eagerly the CPU speeds up.", EFFECTS["power.epp"], cpuOff ? lockText : null)} />
          </WithDetails>
          {cpuRows}
        </PanelSectionRow>
      )}
      {cpu?.turbo && (
        <PanelSectionRow>
          <WithDetails details={turboD}>
            {quick ? (
              <ToggleField label={label("CPU boost", turboD)} disabled={!!cpuOff} checked={sh.turbo ?? state.now.turbo ?? true}
                onChange={(c) => d.write({ turbo: c })}
                description={explainWhen(`Off saves battery in light games.${dflt(v.turbo === null)}`, EFFECTS["power.turbo"], cpuOff ? lockText : null)} />
            ) : (
              <DropdownItem label={label("CPU boost", turboD)} disabled={!!cpuOff} rgOptions={TURBO_OPTIONS}
                selectedOption={v.turbo === null ? "fw" : v.turbo ? "on" : "off"}
                onChange={(o) => d.write({ turbo: o.data === "fw" ? null : o.data === "on" })}
                description={explainWhen("Off saves battery in light games.", EFFECTS["power.turbo"], cpuOff ? lockText : null)} />
            )}
          </WithDetails>
          {(quick || !(cpu && cpu.epp_choices.length > 0)) && cpuRows}
        </PanelSectionRow>
      )}
      {quick && cpu && active && (
        <PanelSectionRow>
          <Status ok={null} label="CPU now" detail={cpuNowLine(state.now)}
            details={det("CPU now", ["The CPU values in effect now: speed cap, minimum, energy preference, CPU boost and the CPU vs GPU balance (with the power mode it counts in).",
              "The minimum is the device's own floor on battery."])} />
        </PanelSectionRow>
      )}
      {!quick && (
        <PanelSectionRow>
          <WithDetails details={resetD}>
            <ButtonItem layout="below" onClick={async () => {
              const ok = await confirm({ title: "Reset to device defaults?", ok: "Reset", effect: EFFECTS["power.reset"],
                text: `Every value of ${what} goes back to the device's own. The fan and scheduler modes stay.` });
              if (ok) { d.write({ ...RESET }); powerWriter.flush(); }
            }} description={explainWhen("Undoes every change in this profile.", EFFECTS["power.reset"])}>
              {label("Reset to device defaults", resetD)}
            </ButtonItem>
          </WithDetails>
        </PanelSectionRow>
      )}
      <PanelSectionRow><Problem what="Power" error={d.error} /></PanelSectionRow>
    </>
  );
};

/** "Separate profile for <game>": a copy of the default for the running game, or back to the default (asks first). */
export const GameProfileToggle: FC<{ app: RunningApp; info: PowerInfo }> = ({ app, info }) => {
  const act = useAction();
  const has = !!info.profiles[app.appid];
  // a profile without a name (imported from SimpleDeckyTDP) gets the game's, once (this call only sets the name)
  const named = useRef<string | null>(null);
  const unnamed = has && info.profiles[app.appid].name == null && !!app.name;
  useEffect(() => {
    if (!unnamed || named.current === app.appid) return;
    named.current = app.appid;
    power_profile(app.appid, app.name.slice(0, 128), true).then(settle, () => undefined);
  }, [unnamed, app.appid]);
  const details = det(`Separate profile for ${app.name}`, ["On: this game gets its own values, starting as a copy of the default profile; the sliders then edit them.",
    "Off: the game's profile is deleted (asks first) and it uses the default profile again."]);
  return (
    <PanelSectionRow>
      <WithDetails details={details}>
        <ToggleField label={label(`Separate profile for ${app.name}`, details)} checked={has} disabled={!!act.busy}
          onChange={(on) => act.run("profile", async () => {
            if (!on && !(await confirm({ title: `Delete the profile of ${app.name}?`, ok: "Delete", destructive: true,
              effect: EFFECTS["power.game_profile"], text: `${app.name} then uses the default profile.` }))) return null;
            await powerWriter.drain();     // a slider change just made lands on the profile it was made on
            return settle(await power_profile(app.appid, on ? app.name : null, on));
          })}
          description={explainWhen(has ? "Sliders edit this game's profile." : "Uses the default profile.", EFFECTS["power.game_profile"])} />
      </WithDetails>
      <Problem what="Game profile" error={act.error} />
    </PanelSectionRow>
  );
};

/** The quick panel's Power section. */
export const PowerSection: FC<{ quick?: boolean; app?: RunningApp | null }> = ({ quick, app }) => {
  const visible = useQuickAccessVisible();
  const shows = !quick || visible;
  const p = usePower(shows);
  const ex = useExtrasState();
  useEffect(() => { if (quick && !visible) clearRecentFixes(); }, [quick, visible]);
  const s = p.state;
  const profiles = p.info?.profiles;
  const slot = s ? editSlot(s, p.info?.options) : "main";
  const prof = s && profiles ? profiles[s.active.key] : undefined;
  const stored = s ? (s.active.slot === slot ? s.values : (slot === "ac" ? prof?.ac ?? prof?.main : prof?.main) ?? s.values) : EMPTY;
  return (
    <PanelSection title="Power">
      {quick && <LiveRow active={shows} />}
      {!s && (
        <PanelSectionRow>
          {!p.error && <Status ok={null} label="Reading the power limits…" />}
          <Problem what="Power" error={p.error} />
        </PanelSectionRow>
      )}
      {s && <PowerStatusRows info={p.info} state={s} quick={quick} />}
      {s && <EnableToggle state={s} info={p.info} quick={quick} />}
      {s && s.enabled && app && p.info?.options.per_game && <GameProfileToggle app={app} info={p.info} />}
      {s && s.enabled && (
        <ValuesEditor state={s} info={p.info} profileKey={s.active.key} slot={slot} stored={stored} active quick={quick}
          label={`${s.active.key === "default" ? "the default profile" : `the profile of ${s.active.name || `app ${s.active.key}`}`}${p.info?.options.split_ac ? (slot === "ac" ? " (plugged-in values)" : " (battery values)") : ""}`} />
      )}
      {s && <ExtrasRows profileKey={s.active.key} slot={slot} stored={stored} x={ex.x} errors={!s.enabled} />}
    </PanelSection>
  );
};

/**
 * Fan mode and scheduler mode of a profile slot (also while power control is off), then the battery's own rows.
 * errors: show a refused power_set here too (false where a ValuesEditor beside it already shows the same error).
 */
export const ExtrasRows: FC<{ profileKey: string; slot: Slot; stored: PowerValues; x: ExtrasState | null; battery?: boolean; errors?: boolean; active?: boolean }> =
  ({ profileKey, slot, stored, x, battery = true, errors = true, active = true }) => {
    const d = useDraft(profileKey, slot, stored);
    if (!x) return null;
    return (
      <PanelSectionRow>
        <ProfileExtras v={d.values} write={d.write} x={x} active={active} />
        {battery && <ChargeRows x={x} />}
        {errors && <Problem what="Power" error={d.error} />}
      </PanelSectionRow>
    );
  };
