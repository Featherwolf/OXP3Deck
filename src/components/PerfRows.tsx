// The performance batch's rows (DESIGN.md "Performance batch (ROADMAP N-1, N-2 + N-5 read, T1-2, N-4, T1-11 + N-7)"):
// the one-tap presets, the low-battery status, the variable-refresh row, the per-game power tip, the device check
// and the RAPL time windows. The texts and decisions are pure functions in power.ts and display.ts (node-tested);
// profile values go through the store's one writer (powerWriter), as every other power control does.
import { ButtonItem, DialogButton, Field, Focusable, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";

import { blockedBy, started, useAction } from "../actions";
import { power_advice, power_advice_dismiss, power_measure, power_profile, power_selftest } from "../backend";
import { VRR_LABEL, VRR_LINE, VRR_TIP_KEY, vrrDetails, vrrKernelKey, vrrShown } from "../display";
import { EFFECTS } from "../effects";
import {
  adviceTarget,
  adviceDetails, adviceLine, adviceUsable, editSlot, follows, LOW_SLIDER, lowLine, lowOptions, lowToggleLine, measureLine,
  measureLines, pl1Change, PRESET_IDS, PRESET_LABEL, presetCaps, presetDetails, presetFieldsOf, presetLine, presetOf,
  presetValues, presetWrite, probeLine, selftestLine, timeWindowsLine, timeWindowsLines, watts, type PresetId,
} from "../power";
import type { RunningApp } from "../steam";
import { afterJob, invalidate, load, notePower, powerWriter, useCurrentJob, useResource } from "../store";
import type { Job, Oxp3Status, PowerAdvice, PowerAdviceRes, PowerInfo, PowerOptions, PowerState, PowerValues, Slot } from "../types";
import { remember } from "../util";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { explain, explainWhen, INFO, label, MUTED, Problem, Status, WithDetails } from "./Hint";
import { JobView } from "./JobView";

const det = (title: string, body: (string | null | undefined | false)[], lines?: string[], linesTitle?: string): DetailsSpec =>
  ({ title, body: paragraphs(body), lines, linesTitle });

const FOCUS = "#1a9fff";
const UNDO_MS = 30000;

// ---- C. presets ------------------------------------------------------------------------------------------------

// the last preset tap per profile slot, so its Undo survives a group closing and opening again
const undoBy = new Map<string, { id: PresetId; before: Partial<PowerValues>; at: number }>();

/**
 * "Preset ⓘ" with one line, then Battery / Balanced / Performance / Max (the matching one drawn selected). One tap
 * writes the preset's fields into this profile slot; Undo for 30 s puts the previous ones back. "Custom" is no
 * button: it is what the line says once a field was set by hand.
 */
export const PresetRow: FC<{ state: PowerState; info: PowerInfo | null; profileKey: string; slot: Slot; stored: PowerValues }> =
  ({ state, info, profileKey, slot, stored }) => {
    const opts = info?.options ?? { split_ac: false, extended: false };
    const caps = presetCaps(info, state);
    const cur = presetOf(stored, state.range, slot, opts, caps);
    const measured = !!info?.selftest?.measured;
    const k = `${profileKey}/${slot}`;
    const [, bump] = useState(0);
    const u = undoBy.get(k);
    const undoLive = !!u && Date.now() - u.at < UNDO_MS && cur === u.id;
    useEffect(() => {
      if (!u) return undefined;
      if (!undoLive) { undoBy.delete(k); return undefined; }
      const t = setTimeout(() => { undoBy.delete(k); bump((n) => n + 1); }, Math.max(0, UNDO_MS - (Date.now() - u.at)));
      return () => clearTimeout(t);
    }, [k, u?.at, undoLive]);
    const why = state.enabled ? null : "Turn on power control first.";
    const tap = (id: PresetId) => {
      undoBy.set(k, { id, before: presetFieldsOf(stored), at: Date.now() });
      powerWriter.write(profileKey, slot, presetWrite(presetValues(id, state.range, slot, opts, caps), stored));
      powerWriter.flush();
      bump((n) => n + 1);
    };
    const undo = () => {
      if (!u) return;
      undoBy.delete(k);
      powerWriter.write(profileKey, slot, u.before);
      powerWriter.flush();
      bump((n) => n + 1);
    };
    const line = presetLine(cur, stored, measured);
    const d = det("Preset", presetDetails(cur, stored, info?.selftest?.measures), ["power.ts presetValues; written with power_set like the sliders"]);
    return (
      <PanelSectionRow>
        <Status ok={null} label="Preset" detail={explainWhen(line, EFFECTS["power.preset"], why)} details={d} />
        <Focusable flow-children="horizontal" style={{ display: "flex", gap: 6, padding: "2px 0 6px" }}>
          {PRESET_IDS.map((id) => (
            <DialogButton key={id} disabled={!!why} onClick={() => tap(id)}
              style={{ flex: 1, minWidth: 0, padding: "6px 2px", fontSize: "0.85em",
                fontWeight: cur === id ? "bold" : undefined, border: cur === id ? `2px solid ${FOCUS}` : "2px solid transparent" }}>
              {PRESET_LABEL[id]}
            </DialogButton>
          ))}
        </Focusable>
        {slot === "low" && (
          <Field bottomSeparator="none" label={null}
            description={<span style={{ whiteSpace: "normal" }}>{LOW_NEVER_ABOVE}</span>} />
        )}
        {undoLive && u && (
          <Field focusable bottomSeparator="none" label={`Set to ${PRESET_LABEL[u.id]}`} onActivate={undo} onOKActionDescription="Undo"
            description={<span style={{ whiteSpace: "normal" }}>Press A to undo: puts the previous values back.</span>} />
        )}
      </PanelSectionRow>
    );
  };

/** Under the presets of the low slot: what runs is min(the profile's own, these) (power.py _merge_low). */
export const LOW_NEVER_ABOVE = "Low battery: never above the profile's own values.";

// ---- D. low battery --------------------------------------------------------------------------------------------

/** The status row while the low-battery values run ("18 %: saving power until 25 % …") or a game's profile holds them back. */
export const LowBatteryRow: FC<{ state: PowerState }> = ({ state }) => {
  const l = lowLine(state.low, state.active.name);
  if (!state.enabled || !l || !state.low) return null;
  const v = state.applied_values;
  const d = det("Low battery", [
    state.low.active
      ? `The battery is at ${state.low.pct ?? "?"} %, so the Default profile's low-battery values run until ${state.low.leave_pct} % or until you plug in.`
      : `The battery is at ${state.low.pct ?? "?"} %, but ${state.active.name || "this game"} has its own profile, which keeps its values. Turn on "Also for games with their own profile" on the Power tab to save power there too.`,
    "The low-battery values are never higher than the profile's own: each limit is the lower of the two.",
    state.low.active ? `In effect: sustained ${watts(v.pl1_w)}, boost ${watts(v.pl2_w)}.` : null,
    "Change them on the Power tab: Profiles, Default, Edit values for: Low battery.",
  ]);
  return (
    <PanelSectionRow>
      <Status ok={null} label={l.label} details={d}
        detail={l.muted ? <span style={{ color: MUTED }}>{l.line}</span> : l.line} />
    </PanelSectionRow>
  );
};

/** "Low battery below": 10..40 % in 5 % steps, sent 400 ms after the last move. */
const LowPctSlider: FC<{ pct: number; disabled: boolean; set: (o: Partial<PowerOptions>) => void }> = ({ pct, disabled, set }) => {
  const [draft, setDraft] = useState<number | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  useEffect(() => { setDraft(null); }, [pct]);
  const shownPct = Math.min(LOW_SLIDER.max, Math.max(LOW_SLIDER.min, draft ?? pct));
  const d = det("Low battery below", ["The charge at which the low-battery values start. They end 5 % higher, or when you plug in."]);
  return (
    <WithDetails details={d}>
      <SliderField label={label("Low battery below", d)} value={shownPct} min={LOW_SLIDER.min} max={LOW_SLIDER.max} step={LOW_SLIDER.step}
        showValue valueSuffix=" %" disabled={disabled}
        onChange={(x) => {
          const v = Math.round(x / LOW_SLIDER.step) * LOW_SLIDER.step;
          setDraft(v);
          if (t.current) clearTimeout(t.current);
          t.current = setTimeout(() => { t.current = null; set({ low_battery_pct: v }); }, 400);
        }}
        description={explainWhen("Where the low-battery values start.", EFFECTS["power.low_battery_pct"])} />
    </WithDetails>
  );
};

/** The Control section's low-battery and power-tip options. */
export const PerfOptions: FC<{ info: PowerInfo; busy: boolean; set: (name: string, o: Partial<PowerOptions>) => void }> = ({ info, busy, set }) => {
  const lo = lowOptions(info.options);
  const advisor = info.options.advisor ?? true;
  const lowD = det("Save power on low battery", [
    `On battery at ${lo.pct} % or less, the Default profile uses its low-battery values (the Battery preset unless you changed them) until ${lo.pct + 5} % or until you plug in.`,
    "Never higher than the profile's own values: each limit is the lower of the two.",
    "A game with its own profile keeps its values, unless the next option is on. While it is active, a Low battery row says so.",
    lo.on ? `Low-battery values now: edit them under Profiles, Default, Edit values for: Low battery.` : null,
  ]);
  const gamesD = det("Also for games with their own profile", ["On: the low-battery values apply also while a game with its own profile runs (never higher than its values).",
    "Off: a game's own profile keeps its values; the Low battery row says it is held."]);
  const advD = det("Power tips while playing", [
    "While a game runs with power control on, OXP3 Deck measures its power use every 5 s (cheaply: no GPU clock reads) and, after 5 minutes, may suggest a sustained limit in This game.",
    "Nothing changes until you tap the suggestion. Turn this off to stop the measuring.",
  ]);
  return (
    <>
      <WithDetails details={lowD}>
        <ToggleField label={label("Save power on low battery", lowD)} checked={lo.on} disabled={busy}
          onChange={(c) => set("low_battery", { low_battery: c })}
          description={explainWhen(lowToggleLine(lo.pct), EFFECTS["power.low_battery"])} />
      </WithDetails>
      {lo.on && <LowPctSlider pct={lo.pct} disabled={busy} set={(o) => set("low_battery_pct", o)} />}
      {lo.on && (
        <WithDetails details={gamesD}>
          <ToggleField label={label("Also for games with their own profile", gamesD)} checked={lo.games} disabled={busy}
            onChange={(c) => set("low_battery_games", { low_battery_games: c })}
            description={explainWhen("Off: a game's own profile keeps its values.", EFFECTS["power.low_battery_games"])} />
        </WithDetails>
      )}
      <WithDetails details={advD}>
        <ToggleField label={label("Power tips while playing", advD)} checked={advisor} disabled={busy}
          onChange={(c) => set("advisor", { advisor: c })}
          description={explainWhen("Measures power use while a game runs and suggests a limit.", EFFECTS["power.advisor"])} />
      </WithDetails>
    </>
  );
};

// ---- A. variable refresh ---------------------------------------------------------------------------------------

/**
 * "Variable refresh is safe ⓘ" while oxp3-tool says so (refresh.vrr_safe); A and ☰ open its text with "Don't show
 * again" (hidden until the kernel changes) and "Close". The plugin changes nothing here.
 */
export const VrrRow: FC<{ status: Oxp3Status | null | undefined }> = ({ status }) => {
  const [hidden, setHidden] = useState<string | null>(() => remember.get(VRR_TIP_KEY));
  const kernel = vrrKernelKey(status?.os.kernel);
  if (!vrrShown(status?.refresh, kernel, hidden)) return null;
  const open = async () => {
    const t = vrrDetails(status?.refresh);
    const hide = await confirm({ title: VRR_LABEL, ok: "Don't show again", cancel: "Close",
      text: paragraphs(t.body), lines: t.lines, linesTitle: "Technical:" });
    if (hide) { remember.set(VRR_TIP_KEY, kernel); setHidden(kernel); }
  };
  return (
    <PanelSectionRow>
      <Field focusable bottomSeparator="none" label={<>{VRR_LABEL}{INFO}</>}
        onActivate={open} onOKActionDescription="Details" onOptionsButton={open} onOptionsActionDescription="Details"
        description={<span style={{ whiteSpace: "normal" }}>{VRR_LINE}</span>} />
    </PanelSectionRow>
  );
};

// ---- E. power tips ---------------------------------------------------------------------------------------------

const ADVICE_MS = 60000;

/** power_advice for the running game: when the group opens and every 60 s while the panel shows (no sysfs cost). */
export const useAdvice = (appid: string | null, visible: boolean, on: boolean) => {
  const key = appid && on ? `power-advice:${appid}` : null;
  const loader = () => power_advice(appid ?? "");
  const res = useResource<PowerAdviceRes>(key, loader, { skip: !visible, fresh: true });
  useEffect(() => {
    if (!key || !visible) return undefined;
    const t = setInterval(() => { load(key, loader); }, ADVICE_MS);
    return () => clearInterval(t);
  }, [key, visible]);
  return { advice: res.data?.ok ? res.data.advice : null, reload: res.reload };
};

// "Set to 15 W" + Undo after a tap, per game, until another game runs
type Used = { appid: string; key: string; slot: Slot; w: number; before: Partial<PowerValues>; created: boolean };
let usedNow: Used | null = null;

/**
 * The "This game" group's Power tip: one line, "Use N W" (headroom and raise) and "Dismiss". Nothing is written
 * until "Use N W" is tapped; then a "Set to N W" row with Undo until the game changes.
 */
export const PowerTipRows: FC<{ app: RunningApp; info: PowerInfo; state: PowerState; visible: boolean }> = ({ app, info, state, visible }) => {
  const act = useAction();
  const on = state.enabled && state.active.slot !== "low" && (info.options.advisor ?? true);
  const { advice, reload } = useAdvice(app.appid, visible, on);
  const [, bump] = useState(0);
  if (usedNow && usedNow.appid !== app.appid) usedNow = null;
  if (!on) return null;
  const used = usedNow;
  const a: PowerAdvice | null = advice && advice.appid === app.appid ? advice : null;

  const use = (x: PowerAdvice & { suggest_w: number }) => act.run("use", async () => {
    const w = x.suggest_w;
    const own = !!info.profiles[app.appid];
    let key = "default";
    let created = false;
    if (own && info.options.per_game) key = app.appid;
    else if (info.options.per_game) {
      if (!(await confirm({ title: `Use ${watts(w)} for ${app.name}?`, ok: `Use ${watts(w)}`, effect: EFFECTS["power.advice_use"],
        text: `Makes a power profile for ${app.name} (a copy of Default) with sustained power ${watts(w)}. Other games keep Default.` }))) return null;
      await powerWriter.drain();
      const e = notePower(await power_profile(app.appid, app.name.slice(0, 128), true));
      if (e) return e;
      key = app.appid;
      created = true;
    } else if (!(await confirm({ title: `Use ${watts(w)} for every game?`, ok: `Use ${watts(w)}`, effect: EFFECTS["power.advice_use"],
      text: `Sets sustained power ${watts(w)} in the Default profile, which every game uses.` }))) return null;
    const slot = editSlot(state, info.options);
    const prof = info.profiles[key] ?? info.profiles.default;
    const stored = (slot === "ac" ? prof?.ac ?? prof?.main : prof?.main) ?? state.values;
    const pl2Shown = stored.pl2_w ?? state.applied_values.pl2_w;
    usedNow = { appid: app.appid, key, slot, w, before: { pl1_w: stored.pl1_w, pl2_w: stored.pl2_w }, created };
    powerWriter.write(key, slot, { pl1_w: w, ...pl1Change(w, pl2Shown, follows(stored)) });
    powerWriter.flush();
    bump((n) => n + 1);
    return null;
  });
  const undo = () => {
    const u = usedNow;
    if (!u) return;
    usedNow = null;
    powerWriter.write(u.key, u.slot, u.before);
    powerWriter.flush();
    bump((n) => n + 1);
  };
  const dismiss = (x: PowerAdvice) => act.run("dismiss", async () => {
    const r = await power_advice_dismiss(app.appid, x.kind, x.pl1_w);
    await reload();
    return r.ok ? null : r.error || "refused";
  });

  if (!a && !used) return act.error ? <PanelSectionRow><Problem what="Power tip" error={act.error} onRetry={act.retry} /></PanelSectionRow> : null;
  const d = a ? det("Power tip", adviceDetails(a), [`${a.stats.samples} samples over ${Math.round(a.seconds)} s at ${watts(a.pl1_w)} (${a.ac ? "plugged in" : "on battery"})`,
    `package p90 ${a.stats.p90_package_w} W · GPU busy p90 ${Math.round(a.stats.p90_gpu_busy_pct)} % · limited ${Math.round(a.stats.limited_share * 100)} % · thermal ${Math.round(a.stats.thermal_share * 100)} %`,
    "sources: RAPL energy_uj, xe gtidle idle_residency_ms, throttle reasons (only while the GPU is busy)"]) : null;
  return (
    <PanelSectionRow>
      {a && !(used && used.w === a.suggest_w) && (
        <>
          <Status ok={null} label="Power tip" detail={adviceLine(a)} details={d} />
          <Focusable flow-children="horizontal" style={{ display: "flex", gap: 6, padding: "2px 0 6px" }}>
            {adviceUsable(a) && (
              <DialogButton disabled={!!act.busy} onClick={() => use(a)} style={{ flex: 1, minWidth: 0, padding: "6px 2px", fontSize: "0.85em" }}>
                {`Use ${watts(a.suggest_w)}`}
              </DialogButton>
            )}
            <DialogButton disabled={!!act.busy} onClick={() => dismiss(a)} style={{ flex: 1, minWidth: 0, padding: "6px 2px", fontSize: "0.85em" }}>
              Dismiss
            </DialogButton>
          </Focusable>
          {adviceUsable(a) && <Field bottomSeparator="none"
            description={explainWhen(`Use ${watts(a.suggest_w)} writes the sustained power of ${adviceTarget(app.name, !!info.profiles[app.appid], info.options.per_game)}.`, EFFECTS["power.advice_use"])} />}
        </>
      )}
      {used && (
        <Field focusable bottomSeparator="none" label={`Set to ${watts(used.w)}`} onActivate={undo} onOKActionDescription="Undo"
          description={<span style={{ whiteSpace: "normal" }}>{`Press A to undo: puts the previous limit back.${used.created ? ` The profile for ${app.name} stays.` : ""}`}</span>} />
      )}
      <Problem what="Power tip" error={act.error} onRetry={act.retry} />
    </PanelSectionRow>
  );
};

// ---- B. device check and measurement ---------------------------------------------------------------------------

/** "Check power controls" and "Measure 60 s" with their last results (the Power tab, after Device defaults). */
export const DeviceCheckSection: FC<{ info: PowerInfo; state: PowerState; game: RunningApp | null }> = ({ info, state, game }) => {
  const act = useAction();
  const job = useCurrentJob();
  const running = job?.state === "running" ? job : null;
  const st = info.selftest ?? null;
  const testLine = selftestLine(st?.test);
  const last = st?.measures?.[0] ?? null;
  const testWhy = running ? `Wait for ${running.title}.` : !state.enabled ? "Turn on power control first."
    : game ? "Quit the game first." : state.blocked ? "Power control is paused." : null;
  const follow = (r: { ok: boolean; error: string | null; job: Job | null }) => {
    const e = started(r);
    if (!e && r.job) afterJob(r.job.id, (j) => { if (j.state === "done") invalidate("power"); });
    return e;
  };
  const checkD = det("Check power controls", [
    "Moves each power setting OXP3 Deck controls by a small step (1 W, 50 MHz, one step of a choice), reads what the device took, and puts the value from just before back at once. Nothing stays changed.",
    "Lists what works, what the firmware locks or ignores, and what this device does not have. Takes about 20 s; it stops if a game starts or the charger changes.",
  ]);
  const measD = det("Measure 60 s", [
    "Reads the package power, GPU busy time, battery draw and throttle reasons every 2 s for one minute. Changes nothing.",
    "With no game: the idle power. While a game runs: that game at its current limits (go back to the game after starting it).",
  ]);
  const testD = st?.test ? det("Last check", [
    ...st.test.probes.map(probeLine),
    st.test.stopped ? `Stopped: ${st.test.stopped}` : null,
    timeWindowsLine(st.test.time_windows) ? `Power time windows: ${timeWindowsLine(st.test.time_windows)}.` : null,
  ], [...st.test.probes.map((p) => `${p.id}: ${p.outcome}${p.before != null ? ` before ${p.before}` : ""}${p.tried != null ? ` tried ${p.tried}` : ""}${p.read != null ? ` read ${p.read}` : ""}`),
    ...timeWindowsLines(st.test.time_windows), `kernel ${st.test.kernel ?? "?"} · BIOS ${st.test.bios ?? "?"}`]) : null;
  const measD2 = last ? det("Last measurement", [measureLine(last), ...(st?.measures ?? []).slice(1).map((m) => measureLine(m))],
    measureLines(last)) : null;
  return (
    <PanelSection title="Device check">
      <PanelSectionRow>
        <WithDetails details={checkD}>
          <ButtonItem layout="below" disabled={!!act.busy || !!testWhy}
            onClick={() => act.run("selftest", async () => {
              const b = blockedBy();
              if (b) return b;
              if (!(await confirm({ title: "Check power controls?", ok: "Check", effect: EFFECTS["power.selftest"],
                text: "OXP3 Deck moves each power setting it controls by a small step, reads what the device took, and puts the old value back at once. Nothing stays changed. Locked and missing controls are listed." }))) return null;
              await powerWriter.drain();
              return follow(await power_selftest());
            })}
            description={explainWhen("Changes each setting a little, reads it back, puts it back (about 20 s).", EFFECTS["power.selftest"], testWhy)}>
            {act.busy === "selftest" ? "Starting…" : label("Check power controls", checkD)}
          </ButtonItem>
        </WithDetails>
        <WithDetails details={measD}>
          <ButtonItem layout="below" disabled={!!act.busy || !!running}
            onClick={() => act.run("measure", async () => blockedBy() ?? follow(await power_measure(game ? "game" : "idle")))}
            description={explain(running ? `Wait for ${running.title}.`
              : game ? "Measures this game for one minute: go back to the game now." : "Measures power use for one minute with no game running.")}>
            {act.busy === "measure" ? "Starting…" : label("Measure 60 s", measD)}
          </ButtonItem>
        </WithDetails>
        {act.job && <JobView job={act.job} lines={6} />}
        <Problem what="Device check" error={act.error} onRetry={act.retry} />
        {testLine && <Status ok={testLine.red ? false : null} red={testLine.red} label="Last check" detail={testLine.line} details={testD} />}
        {!st?.test && <Status ok={null} label="Last check" detail="Not checked on this device yet." />}
        {last && <Status ok={null} label="Last measurement" detail={measureLine(last)} details={measD2} />}
      </PanelSectionRow>
    </PanelSection>
  );
};

/** "Power time windows ⓘ  Sustained over 28 s, boost over 2.4 ms" (read only; the Device defaults section). */
export const TimeWindowsRow: FC<{ info: PowerInfo }> = ({ info }) => {
  const tw = info.hw.time_windows;
  const line = timeWindowsLine(tw);
  if (!line) return null;
  return (
    <Status ok={null} label="Power time windows" detail={line}
      details={det("Power time windows", [
        "How long the processor averages its power before the sustained limit applies. Read only: OXP3 Deck never changes it.",
        "The CPU uses the lower of its two power-limit interfaces (MSR and MMIO), each with its own windows.",
      ], timeWindowsLines(tw), "Per interface:")} />
  );
};
