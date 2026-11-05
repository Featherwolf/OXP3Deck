// The extras' rows (DESIGN.md "Extras", "Frontend 0.4"): fan mode and CPU scheduler mode (per profile: stored in the
// profile through the power writer, applied by the backend's extras), battery charge limit and "Run from charger"
// (global: extras_set), the intel_lpmd pause (Power tab) and the note for kernels without the battery and fan driver.
import { ButtonItem, DropdownItem, SliderField, ToggleField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";

import { useAction } from "../actions";
import { extras_set, extras_take_control } from "../backend";
import { EFFECTS } from "../effects";
import { noteExtras, useExtras } from "../store";
import type { ExtrasState, ExtrasWhat, FanMode, PowerValues, ScxMode } from "../types";
import { DetailsSpec, paragraphs } from "./confirm";
import { explainWhen, label, Note, Problem, Status, WithDetails } from "./Hint";

const det = (title: string, body: (string | null | undefined | false)[], lines?: string[]): DetailsSpec =>
  ({ title, body: paragraphs(body), lines });

/** The extras answer (null while it loads or when the backend has no extras). */
export const useExtrasState = (): { x: ExtrasState | null; error: string | null } => {
  const r = useExtras();
  return { x: r.data?.ok ? r.data.extras : null, error: r.data && !r.data.ok ? r.data.error : null };
};

const TakeControl: FC<{ what: ExtrasWhat; label: string }> = ({ what, label: text }) => {
  const act = useAction();
  return (
    <>
      <ButtonItem layout="below" disabled={!!act.busy}
        onClick={() => act.run(what, async () => noteExtras(await extras_take_control(what)))}
        description={explainWhen("Applies your setting again.", EFFECTS["extras.take_control"])}>
        {act.busy ? "Working…" : text}
      </ButtonItem>
      <Problem what={text} error={act.error} />
    </>
  );
};

const FAN_OPTS: { data: FanMode; label: string }[] = [{ data: "auto", label: "Auto" }, { data: "quiet", label: "Quiet" }, { data: "max", label: "Max" }];
const SCX_OPTS: { data: ScxMode | null; label: string }[] = [{ data: null, label: "Leave as it is" }, { data: "auto", label: "Auto" },
  { data: "gaming", label: "Gaming" }, { data: "powersave", label: "Power save" }];

/** Fan mode and scheduler mode of one profile slot; `write` is the profile's draft writer. */
export const ProfileExtras: FC<{ v: PowerValues; write: (values: Partial<PowerValues>) => void; x: ExtrasState | null }> = ({ v, write, x }) => {
  if (!x) return null;
  const fan = x.fan;
  const scx = x.scx;
  const fanD = det("Fan", [
    "Auto: the device's own fan curve. Quiet: a fixed low speed (about 40 %). Max: full speed.",
    "Quiet goes back to Auto when the CPU reaches 90 °C (Max stays: it is already full speed). Both go back to Auto on any error, before sleep and when OXP3 Deck stops. Per profile.",
    "Handheld Daemon's fan control fights it: turn that off when you use this. Takes effect: Now.",
    fan.reverted ? `Last time: ${fan.reverted}.` : null,
  ], ["oxp_ec hwmon pwm1_enable (2 auto, 1 manual, 0 full) and pwm1", fan.rpm != null ? `now ${fan.rpm} RPM` : "fan1_input"]);
  const scxD = det("CPU scheduler mode", [
    "CachyOS's LAVD scheduler can favour the game (Gaming), save battery (Power save) or decide itself (Auto). Per profile; \"Leave as it is\" changes nothing.",
    "CachyOS's power switch may change it too; OXP3 Deck then stops and says so. Takes effect: Now.",
    scx.note ?? null,
  ], ["org.scx.Loader SwitchScheduler (scx_loader)", "scx_lavd --autopilot / --performance / --powersave", scx.scheduler ? `running: ${scx.scheduler}${scx.mode ? ` (${scx.mode})` : ""}` : "no scheduler"]);
  return (
    <>
      {fan.available && (
        <>
          <WithDetails details={fanD}>
            <DropdownItem label={label("Fan", fanD)} rgOptions={FAN_OPTS} selectedOption={v.fan_mode ?? "auto"}
              onChange={(o) => write({ fan_mode: o.data as FanMode })}
              description={explainWhen(fan.reverted ? fan.reverted : "Auto, Quiet or Max. Quiet goes back to Auto if the CPU gets too hot.", EFFECTS["extras.fan"])} />
          </WithDetails>
          {fan.overridden && (
            <>
              <Status ok={false} red label="Something else changed the fan"
                detail="Likely Handheld Daemon. Turn its fan control off, then Take control."
                details={det("Something else changed the fan", [fan.overridden, "OXP3 Deck stops writing the fan instead of fighting the other program."])} />
              <TakeControl what="fan" label="Take control of the fan" />
            </>
          )}
        </>
      )}
      {scx.shown && (
        <>
          <WithDetails details={scxD}>
            <DropdownItem label={label("CPU scheduler mode", scxD)} rgOptions={SCX_OPTS} selectedOption={v.scx_mode ?? null}
              disabled={!scx.available} onChange={(o) => write({ scx_mode: o.data as ScxMode | null })}
              description={explainWhen("Gaming favours the game; Power save saves battery.", EFFECTS["extras.scx"], scx.available ? null : scx.why)} />
          </WithDetails>
          {scx.overridden && (
            <>
              <Status ok={false} red label="Something else changed the scheduler mode" detail="Likely CachyOS's power switch."
                details={det("Something else changed the scheduler mode", [scx.overridden, "OXP3 Deck stops switching it until you take control again."])} />
              <TakeControl what="scx" label="Take control of the scheduler" />
            </>
          )}
        </>
      )}
    </>
  );
};

/** A slider that sends its value 400 ms after the last move (the backend writes sysfs on each call). */
const useSettled = <T,>(send: (v: T) => void, ms = 400) => {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return (v: T) => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => { t.current = null; latest.current(v); }, ms);
  };
};

/** Battery charge limit and "Run from charger": global, not per profile (they follow the battery). */
export const ChargeRows: FC<{ x: ExtrasState | null }> = ({ x }) => {
  const act = useAction();
  const [draft, setDraft] = useState<number | null>(null);
  const c = x?.charge;
  const sendLimit = useSettled<number>((n) => act.run("limit", async () => { const e = noteExtras(await extras_set({ charge_limit: n })); setDraft(null); return e; }));
  if (!x || !c?.available) return null;
  const limit = draft ?? x.options.charge_limit ?? c.limit ?? 100;
  const awake = (x.options.charge_behaviour ?? c.behaviour) === "inhibit-charge-awake";
  const canAwake = c.behaviours.includes("inhibit-charge-awake");
  const limD = det("Battery charge limit", [
    "Charging stops at this level (50–100 %; 100 = charge fully). Slows battery wear when the device is often plugged in.",
    "Handheld Daemon and Steam may set it too; OXP3 Deck then says so. Takes effect: Now.",
  ], ["power_supply BAT charge_control_end_threshold"]);
  const awakeD = det("Run from charger (battery idle)", [
    "While the device is awake and plugged in, it runs from the charger and leaves the battery alone: less heat when docked. It still charges normally while asleep.",
    "Takes effect: Now.",
  ], ["power_supply BAT charge_behaviour: inhibit-charge-awake / auto"]);
  return (
    <>
      <WithDetails details={limD}>
        <SliderField label={label("Battery charge limit", limD)} value={limit} min={50} max={100} step={5} showValue valueSuffix=" %"
          onChange={(n) => { const v = Math.min(100, Math.max(50, Math.round(n))); setDraft(v); sendLimit(v); }}
          description={explainWhen("Stops charging at this level. Slows battery wear when often plugged in.", EFFECTS["extras.charge_limit"])} />
      </WithDetails>
      {c.overridden.limit && (
        <>
          <Status ok={false} red label="Something else changed the charge limit" detail={c.overridden.limit} />
          <TakeControl what="charge_limit" label="Take control of the charge limit" />
        </>
      )}
      {canAwake && (
        <WithDetails details={awakeD}>
          <ToggleField label={label("Run from charger (battery idle)", awakeD)} checked={awake} disabled={!!act.busy}
            onChange={(on) => act.run("behaviour", async () => noteExtras(await extras_set({ charge_behaviour: on ? "inhibit-charge-awake" : "auto" })))}
            description={explainWhen("While awake and plugged in, the battery is left alone.", EFFECTS["extras.charge_behaviour"])} />
        </WithDetails>
      )}
      {c.overridden.behaviour && (
        <>
          <Status ok={false} red label="Something else changed Run from charger" detail={c.overridden.behaviour} />
          <TakeControl what="charge_behaviour" label="Take control of Run from charger" />
        </>
      )}
      <Problem what="Battery" error={act.error ?? c.error ?? null} />
    </>
  );
};

/** "Battery and fan controls need Linux 7.4" (Power tab): the board matches, only the kernel lacks the driver. */
export const BatteryNote: FC<{ x: ExtrasState | null }> = ({ x }) => {
  if (!x || !x.board_ok || x.charge.available || x.fan.available) return null;
  return (
    <Note label="Battery and fan controls" details={det("Battery and fan controls", [
      "The charge limit, Run from charger and the fan mode need the ONEXPLAYER 3 support of the oxp_ec driver, added in Linux 7.4. Linux 7.2 and 7.3 lack it.",
      `This is ${x.kernel || "an older kernel"}. They show here once you run 7.4 or newer.`,
    ])}>
      {`Need Linux 7.4 or newer (this is ${x.kernel || "older"}).`}
    </Note>
  );
};

/** "Pause Intel's low-power daemon in games" (Power tab, under Other power programs); only while it runs. */
export const LpmdToggle: FC<{ x: ExtrasState | null }> = ({ x }) => {
  const act = useAction();
  if (!x?.lpmd.shown) return null;
  const d = det("Pause Intel's low-power daemon in games", [
    "While a game runs, intel_lpmd is set to off, so it does not move the game to the slow cores; it goes back to automatic when the game ends.",
    "Only while the daemon runs. If it restarts, it is paused once more. Takes effect: Now.",
    x.lpmd.paused ? "Paused now for the running game." : null,
  ], ["org.freedesktop.intel_lpmd LPM_FORCE_OFF / LPM_AUTO", x.lpmd.state ? `state: ${x.lpmd.state}` : "state: unknown"]);
  return (
    <>
      <WithDetails details={d}>
        <ToggleField label={label("Pause Intel's low-power daemon in games", d)} checked={x.options.lpmd_game_off} disabled={!!act.busy}
          onChange={(on) => act.run("lpmd", async () => noteExtras(await extras_set({ lpmd_game_off: on })))}
          description={explainWhen(x.lpmd.paused ? "Paused for the running game." : "Stops it moving the game to slow cores while a game runs.", EFFECTS["extras.lpmd"])} />
      </WithDetails>
      <Problem what="Intel low-power daemon" error={act.error ?? x.lpmd.error} />
    </>
  );
};
