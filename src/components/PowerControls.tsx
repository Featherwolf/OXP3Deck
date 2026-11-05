// Power control (DESIGN.md "Power (TDP, GPU, CPU)", Frontend): the rows the quick panel's Power section and the full
// page's Power tab share. Profile values go through the store's one writer (powerWriter), never straight to
// power_set, so a slider drag reaches the backend in order and a late answer cannot move a slider back.
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { FC, useEffect, useMemo, useRef, useState } from "react";

import { useAction } from "../actions";
import { power_enable, power_info, power_profile, power_take_control } from "../backend";
import {
  blockers, clampW, editSlot, EMPTY, eppOptions, failedLines, fwValues, gpuNotches, pl1Change, pl2Floor, overriddenText,
  profileLine, effectiveLine, shown, Slot, suspects,
} from "../power";
import { RunningApp } from "../steam";
import { invalidate, notePower, powerWriter, usePowerErrors, usePowerState, useResource } from "../store";
import type {
  Epp, PowerChangeRes, PowerConflict, PowerInfo, PowerInfoRes, PowerState, PowerValues,
} from "../types";
import { remember } from "../util";
import { confirm } from "./confirm";
import { explain, Note, Problem, Status } from "./Hint";
import { useQuickAccessVisible } from "./JobView";

/** The cached power info and the live state (polled only while `active`): the state of power_state, else info's. */
export const usePower = (active: boolean) => {
  const info = useResource<PowerInfoRes>("power-info", () => power_info(false));
  const live = usePowerState(active);
  const i = info.data?.ok ? info.data.info : null;
  const state = (live.data?.ok ? live.data.state : null) ?? i?.state ?? null;
  // the conflict rows the guidance is built from: reload them when a blocker or an override shows up (or leaves)
  const watch = `${state?.blocked ?? ""}|${state?.overridden?.since ?? ""}`;
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

const fixRows = (cs: PowerConflict[]) => cs.map((c) => (
  <Status key={c.id} ok={false} red label={c.name} detail={explain(c.why, c.fix ? <>Fix: {c.fix}</> : undefined)} />
));

/** The status line and the red rows: blocked, overridden (with "Take control again"), what did not take. */
export const PowerStatusRows: FC<{ info: PowerInfo | null; state: PowerState }> = ({ info, state }) => {
  const act = useAction();
  const o = state.overridden;
  const fails = failedLines(state.last, state.now.zones);
  return (
    <>
      <PanelSectionRow>
        <Status ok={!state.enabled ? null : !o && !state.blocked}
          label={effectiveLine(state)}
          detail={`${profileLine(state)}${state.enabled ? "" : " · TDP control is off: these are the firmware's limits"}`} />
      </PanelSectionRow>
      {state.enabled && state.blocked && (
        <PanelSectionRow>
          <Status ok={false} red label="TDP control is paused" detail={`${state.blocked} OXP3 Deck writes nothing while it runs.`} />
          {fixRows(blockers(info?.conflicts))}
        </PanelSectionRow>
      )}
      {state.enabled && o && (
        <PanelSectionRow>
          <Status ok={false} red label="Power limits overridden" detail={overriddenText(o, info?.conflicts)} />
          {suspects(o, info?.conflicts).filter((s) => s.fix).map((s) => <Note key={s.name} label={s.name}>{s.fix}</Note>)}
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("take", async () => { await powerWriter.drain(); return settle(await power_take_control()); })}
            description={explain("Writes this profile's values again and watches them as before.",
              "Turn the other power manager's control off first, or it changes them back.")}>
            {act.busy ? "Working…" : "Take control again"}
          </ButtonItem>
          <Problem what="Take control" error={act.error} />
        </PanelSectionRow>
      )}
      {state.enabled && fails.length > 0 && (
        <PanelSectionRow>
          {fails.map((f, n) => <Status key={n} ok={false} label="Not applied" detail={f} />)}
        </PanelSectionRow>
      )}
    </>
  );
};

const ENABLE_SEEN = "powerEnableConfirmed";

/** The "TDP control" toggle: the first enable asks first; a refused one lists each blocking conflict and its fix. */
export const EnableToggle: FC<{ state: PowerState; info: PowerInfo | null }> = ({ state, info }) => {
  const act = useAction();
  const [refused, setRefused] = useState<PowerConflict[]>([]);
  const r = state.range;
  const rangeText = r.spec === "oxp3"
    ? `${r.pl1_min}–${r.pl1_max_battery} W on battery, up to ${r.pl1_max_ac} W on AC`
    : `${r.pl1_min}–${r.pl1_max} W (this device's firmware limits)`;
  const toggle = (on: boolean) => act.run("enable", async () => {
    setRefused([]);
    if (on && remember.get(ENABLE_SEEN) !== "1") {
      const ok = await confirm({
        title: "Turn TDP control on", ok: "Turn on",
        text: (
          <>
            <div>OXP3 Deck then writes the sustained (PL1) and boost (PL2) power limits to both of the CPU's RAPL interfaces
              (MSR and MMIO), the Arc GPU's clock range and the CPU's energy preference and boost, as the active profile says.
              Fields left at "firmware" keep the values the system booted with: the default profile starts that way, so nothing
              changes until you move a slider.</div>
            <div style={{ marginTop: 8 }}>Range: {rangeText}. Profiles follow the running game and, if you want, AC power.</div>
            <div style={{ marginTop: 8 }}>Turning TDP control off writes the firmware values back; a reboot gives them back too.</div>
          </>
        ),
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
  return (
    <PanelSectionRow>
      <ToggleField label="TDP control" checked={state.enabled} disabled={!!act.busy || (!state.enabled && info !== null && !info.hw.rapl && !info.hw.mmio)}
        onChange={toggle}
        description={explain(state.enabled
          ? "On: OXP3 Deck sets the power limits, GPU clocks and CPU energy preference from the active profile, again after sleep, on a game change and on AC changes."
          : "Off: the firmware's own limits apply. Turn on to set the power limits (TDP), GPU clocks and CPU boost here instead of SimpleDeckyTDP.",
          state.enabled ? "Turning it off writes the firmware values back at once." : "Takes effect at once; asks first the first time.")} />
      {problems.map((p, n) => <Note key={n}>{p}</Note>)}
      {refused.length > 0 && <Status ok={false} red label="Another power manager is active" detail="Turn it off first; OXP3 Deck does not fight it:" />}
      {fixRows(refused)}
      <Problem what="TDP control" error={act.error} />
    </PanelSectionRow>
  );
};

/** Values typed by the user that the stored profile does not show yet (an answer still on its way). */
const useDraft = (key: string, slot: Slot, stored: PowerValues) => {
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

const fw = (isNull: boolean) => (isNull ? " (firmware value)" : "");

const TURBO_OPTIONS = [{ data: "fw", label: "Firmware" }, { data: "on", label: "On" }, { data: "off", label: "Off" }];

/**
 * The sliders and choices of one profile slot. quick: sustained, boost, GPU max and CPU boost only. `active`: the
 * slot runs now, so null fields show the applied firmware values; otherwise the boot values.
 */
export const ValuesEditor: FC<{
  state: PowerState; info: PowerInfo | null; profileKey: string; slot: Slot; stored: PowerValues; active: boolean;
  label: string; quick?: boolean;
}> = ({ state, info, profileKey, slot, stored, active, label, quick }) => {
  const d = useDraft(profileKey, slot, stored);
  const v = d.values;
  const r = state.range;
  const sh = shown(v, active ? shown(state.applied_values, fwValues(state)) : fwValues(state));
  const pl1 = clampW(sh.pl1_w ?? r.pl1_min, r);
  const pl2Min = pl2Floor(pl1, r);
  const pl2Max = Math.max(pl2Min, Math.floor(r.pl2_max));
  const pl2 = Math.min(pl2Max, Math.max(pl2Min, Math.round(sh.pl2_w ?? pl2Max)));
  const gpu = r.gpu_min != null && r.gpu_max != null && r.gpu_max > r.gpu_min ? { lo: r.gpu_min, hi: r.gpu_max } : null;
  const gpuClamp = (x: number | null, dflt: number) => (gpu ? Math.min(gpu.hi, Math.max(gpu.lo, x ?? dflt)) : 0);
  const gmax = gpuClamp(sh.gpu_max_mhz, gpu?.hi ?? 0);
  const gmin = gpuClamp(sh.gpu_min_mhz, gpu?.lo ?? 0);
  const notches = useMemo(() => gpuNotches(r), [r.gpu_min, r.gpu_max, r.gpu_efficient]);
  const cpu = info?.hw.cpu ?? null;
  const cpuOff = state.cpu_blocked;
  const where = `Edits ${label}.${active ? "" : " Saved now; applied when this profile is active."}`;
  const over = v.pl1_w != null && v.pl1_w > r.pl1_max ? ` Saved ${v.pl1_w} W; runs at ${r.pl1_max} W now (the limit ${state.active.ac ? "on AC" : "on battery"}).` : "";
  return (
    <>
      <PanelSectionRow>
        <SliderField label="Sustained power" value={pl1} min={r.pl1_min} max={Math.max(r.pl1_min, r.pl1_max)} step={1}
          showValue valueSuffix=" W" editableValue={!quick}
          onChange={(x) => d.write(pl1Change(clampW(x, r), pl2))}
          description={explain(`PL1: the power the CPU and GPU share for as long as a game runs${fw(v.pl1_w === null)}.`, `${where}${over}`)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField label="Boost power" value={pl2} min={pl2Min} max={pl2Max} step={1} disabled={pl2Max <= pl2Min}
          showValue valueSuffix=" W" editableValue={!quick}
          onChange={(x) => d.write({ pl2_w: Math.min(pl2Max, Math.max(pl2Min, Math.round(x))) })}
          description={explain(`PL2: the short boost above it (a few seconds), never below sustained${fw(v.pl2_w === null)}.`,
            `Up to ${r.pl2_max} W, the firmware's own boost limit.`)} />
      </PanelSectionRow>
      {gpu && !quick && (
        <PanelSectionRow>
          <SliderField label="GPU min clock" value={gmin} min={gpu.lo} max={gpu.hi} step={50} showValue valueSuffix=" MHz"
            {...notches} notchTicksVisible={false}
            onChange={(x) => d.write(x > gmax ? { gpu_min_mhz: x, gpu_max_mhz: x } : { gpu_min_mhz: x })}
            description={explain(`The Arc GPU never clocks below this${fw(v.gpu_min_mhz === null)}.`,
              "Higher costs power at idle; useful only against clock dips in one game.")} />
        </PanelSectionRow>
      )}
      {gpu && (
        <PanelSectionRow>
          <SliderField label="GPU max clock" value={gmax} min={gpu.lo} max={gpu.hi} step={50} showValue valueSuffix=" MHz"
            {...notches} notchTicksVisible={false}
            onChange={(x) => d.write(x < gmin ? { gpu_max_mhz: x, gpu_min_mhz: x } : { gpu_max_mhz: x })}
            description={explain(`The Arc GPU never clocks above this${fw(v.gpu_max_mhz === null)}.`,
              `A lower cap leaves more of the power to the CPU and saves battery${r.gpu_efficient ? `; ${r.gpu_efficient} MHz is its most efficient clock` : ""}.`)} />
        </PanelSectionRow>
      )}
      {!quick && cpu && cpu.epp_choices.length > 0 && (
        <PanelSectionRow>
          <DropdownItem label="Energy preference (EPP)" disabled={!!cpuOff}
            rgOptions={eppOptions(cpu.epp_choices)} selectedOption={v.epp}
            onChange={(o) => d.write({ epp: o.data as Epp | null })}
            description={explain(cpuOff ?? "How eagerly the CPU clocks up: Performance is fastest, Power saving the most frugal. Firmware: as it booted.",
              state.now.governor === "performance" ? "The CPU governor is performance: EPP cannot change." : undefined)} />
        </PanelSectionRow>
      )}
      {cpu?.turbo && (
        <PanelSectionRow>
          {quick ? (
            <ToggleField label="CPU boost" disabled={!!cpuOff} checked={sh.turbo ?? state.now.turbo ?? true}
              onChange={(c) => d.write({ turbo: c })}
              description={explain(cpuOff ?? `Turbo clocks above the CPU's base clock${fw(v.turbo === null)}.`,
                cpuOff ? undefined : "Off saves power in light games; most games run slower without it.")} />
          ) : (
            <DropdownItem label="CPU boost" disabled={!!cpuOff} rgOptions={TURBO_OPTIONS}
              selectedOption={v.turbo === null ? "fw" : v.turbo ? "on" : "off"}
              onChange={(o) => d.write({ turbo: o.data === "fw" ? null : o.data === "on" })}
              description={explain(cpuOff ?? "Turbo clocks above the CPU's base clock. Off saves power in light games.")} />
          )}
        </PanelSectionRow>
      )}
      {!quick && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => {
            const ok = await confirm({ title: "Use firmware values", ok: "Reset",
              text: `Every value of ${label} goes back to "firmware": the limits the system booted with.` });
            if (ok) { d.write({ ...EMPTY }); powerWriter.flush(); }
          }} description={explain(`Sets every value of ${label} back to the firmware's.`, active ? "Applies at once; asks first." : "Asks first.")}>
            Use firmware values
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow><Problem what="Power" error={d.error} /></PanelSectionRow>
    </>
  );
};

/** "Profile for this game": a copy of the default for the running game, or back to the default (asks first). */
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
  return (
    <PanelSectionRow>
      <ToggleField label="Profile for this game" checked={has} disabled={!!act.busy}
        onChange={(on) => act.run("profile", async () => {
          if (!on && !(await confirm({ title: `Delete the profile of ${app.name}`, ok: "Delete", destructive: true,
            text: `${app.name} then runs with the default profile.` }))) return null;
          await powerWriter.drain();     // a slider change just made lands on the profile it was made on
          return settle(await power_profile(app.appid, on ? app.name : null, on));
        })}
        description={explain(has ? `${app.name} has its own values: the sliders below edit them.`
          : `${app.name} runs with the default profile. On: it gets its own, starting as a copy of the default.`)} />
      <Problem what="Game profile" error={act.error} />
    </PanelSectionRow>
  );
};

/** The quick panel's Power section. */
export const PowerSection: FC<{ quick?: boolean; app?: RunningApp | null }> = ({ quick, app }) => {
  const visible = useQuickAccessVisible();
  const p = usePower(!quick || visible);
  const s = p.state;
  const profiles = p.info?.profiles;
  const slot = s ? editSlot(s, p.info?.options) : "main";
  const prof = s && profiles ? profiles[s.active.key] : undefined;
  const stored = s ? (s.active.slot === slot ? s.values : (slot === "ac" ? prof?.ac ?? prof?.main : prof?.main) ?? s.values) : EMPTY;
  return (
    <PanelSection title="Power">
      {!s && (
        <PanelSectionRow>
          {!p.error && <Status ok={null} label="Reading the power limits…" />}
          <Problem what="Power" error={p.error} />
        </PanelSectionRow>
      )}
      {s && <PowerStatusRows info={p.info} state={s} />}
      {s && <EnableToggle state={s} info={p.info} />}
      {s && s.enabled && app && p.info?.options.per_game && <GameProfileToggle app={app} info={p.info} />}
      {s && s.enabled && (
        <ValuesEditor state={s} info={p.info} profileKey={s.active.key} slot={slot} stored={stored} active quick={quick}
          label={`${s.active.key === "default" ? "the default profile" : `the profile of ${s.active.name || `app ${s.active.key}`}`}${p.info?.options.split_ac ? (slot === "ac" ? " (AC values)" : " (battery values)") : ""}`} />
      )}
    </PanelSection>
  );
};
