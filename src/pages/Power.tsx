// The full page's Power tab (DESIGN.md "Power (TDP, GPU, CPU)", Frontend): the live state per RAPL zone, the options,
// the profile editor for every profile, the other power managers found, the firmware values and the import from
// SimpleDeckyTDP.
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";

import { useAction } from "../actions";
import { power_import_sdtdp, power_info, power_options, power_profile } from "../backend";
import { ConflictRow, ConflictRows, FixedRows } from "../components/ConflictRow";
import { confirm, DetailsSpec, paragraphs } from "../components/confirm";
import { BatteryNote, ChargeRows, LpmdToggle, useExtrasState } from "../components/ExtrasControls";
import { explain, explainWhen, label, Note, Problem, Status, WithDetails } from "../components/Hint";
import { LiveSection } from "../components/LiveRows";
import { cpuBlockers, EnableToggle, ExtrasRows, PowerStatusRows, settle, usePower, ValuesEditor } from "../components/PowerControls";
import { friendlyName } from "../conflicts";
import { EFFECTS } from "../effects";
import { cpuNowLine, limitsLine, pollIndex, pollText, pollValue, POLL_DEFAULT, POLL_STEPS, profileOrder, reasonText, Slot, watts } from "../power";
import { useRunningApp } from "../steam";
import { flushPower, powerWriter, put } from "../store";
import type { ExtrasState, PowerInfo, PowerOptions, PowerState, PowerZone } from "../types";
import { listText, when } from "../util";

const det = (title: string, body: (string | null | undefined | false)[], lines?: string[], linesTitle?: string): DetailsSpec =>
  ({ title, body: paragraphs(body), lines, linesTitle });

const zoneLine = (z: PowerZone) => {
  const lock = (c: string) => (z.locked.includes(c) ? " (locked)" : "");
  return `${z.iface.toUpperCase()} ${z.name}: PL1 ${watts(z.pl1_w)}${lock("pl1")} · PL2 ${watts(z.pl2_w)}${lock("pl2")} · PL4 ${watts(z.pl4_w)}`;
};
const ac = (s: PowerState) => (s.active.ac == null ? "Power source unknown" : s.active.ac ? "Plugged in" : "On battery");

const NowSection: FC<{ info: PowerInfo | null; state: PowerState }> = ({ info, state }) => {
  const n = state.now;
  // MSR and MMIO side by side: the hardware uses the lower of the two
  const zones = [...n.zones].sort((a, b) => (a.iface === b.iface ? a.id.localeCompare(b.id) : a.iface === "msr" ? -1 : 1));
  const why = reasonText(n.gpu?.reasons);
  const held = (n.gpu?.reasons ?? []).some((r) => /^(pl\d|power|vr_tdc)$/.test(r));
  const lockers = cpuBlockers(state, info);
  const lockedBy = `${listText(lockers.map((c) => friendlyName(c.id, c.name))) || "Another program"} controls them.`;
  return (
    <PanelSection title="Status">
      <PowerStatusRows info={info} state={state} />
      <PanelSectionRow>
        {zones.length > 0 ? (
          <Status ok={null} label="Power limits now" detail={limitsLine(state)}
            details={det("Power limits now", ["The limits each of the CPU's two power-limit interfaces holds now; the CPU uses the lower of the two.",
              zones.some((z) => z.iface === "mmio") ? "The firmware rewrites one of them whenever the charger is plugged in or out; OXP3 Deck writes it again." : null],
              zones.map(zoneLine), "Per interface:")} />
        ) : (
          <Status ok={false} label="Power limits not available" detail="This system doesn't expose power limits."
            details={det("Power limits not available", ["No power-limit interface was found, so power limits cannot be read or set here."],
              ["No RAPL zones: the kernel modules intel_rapl_msr and processor_thermal_rapl provide them."])} />
        )}
        {n.gpu && (
          <Status ok={null} label={`GPU ${n.gpu.act ?? "?"} MHz`} detail={held ? "Held back by power limit" : why ? why[0].toUpperCase() + why.slice(1) : "Running freely"}
            details={det("GPU", [`Allowed now: ${n.gpu.min ?? "?"}–${n.gpu.max ?? "?"} MHz.`, why ? `Limited: ${why}.` : "Not limited."],
              n.gpu.reasons.length ? [`throttle reasons: ${n.gpu.reasons.join(", ")}`] : undefined)} />
        )}
        <Status ok={null} label="CPU" detail={cpuNowLine(n)}
          details={det("CPU", ["The CPU values in effect now: the speed cap and minimum (shares of the top speed), energy preference, CPU boost and, with the SoC power slider, the CPU vs GPU balance and the power mode it counts in.",
            "The minimum is the device's own floor on battery; the balance counts only in the Balanced (balanced) power mode.", ac(state)],
          [`governor: ${n.governor ?? "?"}`, `EPP: ${n.epp ?? "?"}`, `intel_pstate max_perf_pct ${n.cpu_max_pct ?? "?"} / min_perf_pct ${n.cpu_min_pct ?? "?"}`,
            `no_turbo: ${n.turbo == null ? "?" : n.turbo ? 0 : 1}`, n.soc ? `slider_balance ${n.soc.balance}, offset ${n.soc.offset}, profile ${n.soc.profile ?? "?"}` : "no SoC power slider"])} />
        {state.enabled && state.cpu_blocked && (
          <>
            <Status ok={false} label="Energy preference & boost: locked" detail={lockedBy}
              details={det("Energy preference & boost: locked", [lockedBy, "Power limits and GPU speed still work."])} />
            <ConflictRows rows={lockers} info={info} />
          </>
        )}
      </PanelSectionRow>
    </PanelSection>
  );
};

const OptionsSection: FC<{ info: PowerInfo; state: PowerState }> = ({ info, state }) => {
  const act = useAction();
  const set = (name: string, o: Partial<PowerOptions>) => act.run(name, async () => { await powerWriter.drain(); return settle(await power_options(o)); });
  const r = state.range;
  const perGameD = det("Per-game profiles", ["A game with a profile of its own uses it; every other game uses the default profile.",
    "Off: every game uses the default profile. Saved game profiles are kept."]);
  const splitD = det("Different settings when plugged in", ["Each profile gets a second set of values, used while the charger is plugged in.",
    "Switches within a few seconds of plugging in or out."]);
  const extD = r.extended_max != null ? det(`Allow up to ${r.extended_max} W when plugged in`, [
    `Raises the sustained limit when plugged in up to ${r.extended_max} W, the device's own boost limit. ONEXPLAYER rates the OXP3 for ${r.pl1_max_battery} W sustained, up to ${r.pl1_max_ac} W.`,
    "Use a charger of 65 W or more: a weaker one cannot keep up, so the battery drains or charging flaps on and off.",
    `On battery the limit stays at ${r.pl1_max_battery} W.`]) : null;
  return (
    <PanelSection title="Control">
      <EnableToggle state={state} info={info} />
      <PanelSectionRow>
        <WithDetails details={perGameD}>
          <ToggleField label={label("Per-game profiles", perGameD)} checked={info.options.per_game} disabled={!!act.busy}
            onChange={(c) => set("per_game", { per_game: c })}
            description={explainWhen("Games with their own profile use it.", EFFECTS["power.per_game"])} />
        </WithDetails>
        <WithDetails details={splitD}>
          <ToggleField label={label("Different settings when plugged in", splitD)} checked={info.options.split_ac} disabled={!!act.busy}
            onChange={(c) => set("split_ac", { split_ac: c })}
            description={explainWhen("Each profile gets a second set for charging.", EFFECTS["power.split_ac"])} />
        </WithDetails>
        {r.extended_max != null && (
          <WithDetails details={extD}>
            <ToggleField label={label(`Allow up to ${r.extended_max} W when plugged in`, extD)} checked={info.options.extended} disabled={!!act.busy}
              onChange={(c) => set("extended", { extended: c })}
              description={explainWhen("Needs a 65 W or stronger charger.", EFFECTS["power.extended"])} />
          </WithDetails>
        )}
        <PollSlider info={info} />
        <Problem what="Option" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const EditorSection: FC<{ info: PowerInfo; state: PowerState; x: ExtrasState | null }> = ({ info, state, x }) => {
  const app = useRunningApp();
  const act = useAction();
  const [key, setKey] = useState<string>(state.active.key);
  const [slotPick, setSlotPick] = useState<Slot>(state.active.slot);
  const k = info.profiles[key] ? key : "default";
  const prof = info.profiles[k];
  const slot: Slot = info.options.split_ac ? slotPick : "main";
  const stored = slot === "ac" ? prof.ac ?? prof.main : prof.main;
  const active = state.active.key === k && state.active.slot === slot;
  const order = profileOrder(info.profiles, app?.appid);
  useEffect(() => { flushPower(); }, [k, slot]);
  const name = k === "default" ? "the default profile" : `the profile of ${prof.name || `app ${k}`}`;
  const canAdd = app && !info.profiles[app.appid];
  const profD = det("Profile to edit", ["The sliders below edit this profile. Changes to a profile that is not active are saved and used when it is.",
    info.options.per_game ? null : "Per-game profiles are off: every game uses the default profile."]);
  const slotD = det("Edit values for", ["Which of the profile's two sets the sliders edit: on battery or plugged in.",
    "The plugged-in set starts as a copy of the battery set at the first change."]);
  return (
    <PanelSection title="Profiles">
      <PanelSectionRow>
        <WithDetails details={profD}>
          <DropdownItem label={label("Profile to edit", profD)} rgOptions={order.map((o) => ({ data: o.key, label: o.label }))} selectedOption={k}
            onChange={(o) => setKey(String(o.data))}
            description={explain(state.active.key === k ? "Active now" : "Saved; used when this game runs")} />
        </WithDetails>
        {info.options.split_ac && (
          <WithDetails details={slotD}>
            <DropdownItem label={label("Edit values for", slotD)} rgOptions={[{ data: "main", label: "Battery" }, { data: "ac", label: "Plugged in" }]}
              selectedOption={slot} onChange={(o) => setSlotPick(o.data as Slot)}
              description={explain("Battery or plugged in.")} />
          </WithDetails>
        )}
        {!state.enabled && <Note>Power control is off: changes are saved for later.</Note>}
      </PanelSectionRow>
      <ValuesEditor key={`${k}/${slot}`} state={state} info={info} profileKey={k} slot={slot} stored={stored} active={active && state.enabled}
        label={`${name}${info.options.split_ac ? (slot === "ac" ? " (plugged-in values)" : " (battery values)") : ""}`} />
      <ExtrasRows key={`x-${k}/${slot}`} profileKey={k} slot={slot} stored={stored} x={x} battery={false} errors={false} active={active} />
      <PanelSectionRow>
        {canAdd && (
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("add", async () => { await powerWriter.drain(); const e = settle(await power_profile(app.appid, app.name, true)); if (!e) setKey(app.appid); return e; })}
            description={explainWhen("Starts as a copy of the default.", EFFECTS["power.new_profile"])}>
            New profile for {app.name}
          </ButtonItem>
        )}
        {k !== "default" && (
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("delete", async () => {
              if (!(await confirm({ title: "Delete profile?", ok: "Delete", destructive: true, effect: EFFECTS["power.delete_profile"],
                text: `${prof.name || `App ${k}`} then uses the default profile.` }))) return null;
              await powerWriter.drain();
              const e = settle(await power_profile(k, null, false));
              if (!e) setKey("default");
              return e;
            })}
            description={explainWhen("The game uses the default profile again.", EFFECTS["power.delete_profile"])}>
            Delete profile
          </ButtonItem>
        )}
        <Problem what="Profile" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const ConflictsSection: FC<{ info: PowerInfo; x: ExtrasState | null }> = ({ info, x }) => {
  const act = useAction();
  const active = new Set(info.conflicts.map((c) => c.id));
  const gone = (info.fixed ?? []).filter((f) => !active.has(f.id));
  const checkD = det("Check again", ["Looks again for other programs that change power limits, energy preference or CPU boost."],
    ["systemd services, running programs, enabled Decky plugins, steamos-manager remotes"]);
  return (
    <PanelSection title="Other power programs">
      <PanelSectionRow>
        {!info.conflicts.length && <Status ok label="No conflicts" detail="Nothing else changes these settings." />}
        {info.conflicts.map((c) => <ConflictRow key={c.id} c={c} info={info} />)}
        <LpmdToggle x={x} />
      </PanelSectionRow>
      {gone.length > 0 && (
        <PanelSectionRow>
          <Note label="Turned off by OXP3 Deck">Undo turns each back on.</Note>
          <FixedRows info={info} />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <WithDetails details={checkD}>
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("check", async () => {
              const r = await power_info(true);
              if (r.ok) put("power-info", r);
              return r.ok ? null : r.error;
            })}
            description={explain("Look for conflicting programs.")}>
            {act.busy === "check" ? "Checking…" : label("Check again", checkD)}
          </ButtonItem>
        </WithDetails>
        <Problem what="Check" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const FirmwareSection: FC<{ info: PowerInfo; state: PowerState }> = ({ info, state }) => {
  const r = state.range;
  const fwD = det("Device defaults", [
    info.boot ? `Read when power control first wrote this boot (${when(info.boot.taken_at)}). Another tool's leftovers show here too; a reboot gives the device's own.`
      : "Not read yet: OXP3 Deck reads them when power control first writes this boot.",
    "Turning power control off restores these.",
    "Before you disable or uninstall OXP3 Deck, turn power control off: the GPU speed range and energy preference it set otherwise stay until a reboot.",
  ], state.now.zones.map((z) => `${z.iface.toUpperCase()} ${z.name}: PL1 ${watts(z.boot_pl1_w)} · PL2 ${watts(z.boot_pl2_w)}${z.pl1_base_w ? ` · base power ${watts(z.pl1_base_w)}` : ""}`),
  "At boot:");
  const gpuD = r.gpu_min != null ? det("GPU speed range", [r.gpu_efficient ? `Most efficient at ${r.gpu_efficient} MHz.` : null],
    info.hw.gpu ? [`${info.hw.gpu.card}, ${info.hw.gpu.gt}`] : undefined) : null;
  const rangeD = det("Allowed range", [r.spec === "oxp3"
    ? `Boost up to ${r.pl2_max} W. ONEXPLAYER's own figures for the OXP3${r.extended_max ? `; up to ${r.extended_max} W plugged in with the option above` : ""}.`
    : `Boost up to ${r.pl2_max} W: never above what this device's firmware set.`]);
  return (
    <PanelSection title="Device defaults">
      <PanelSectionRow>
        <Note label="Device defaults" details={fwD}>Restored when power control is turned off.</Note>
        {r.gpu_min != null && <Status ok={null} label="GPU speed range" detail={`${r.gpu_min}–${r.gpu_max} MHz`} details={gpuD} />}
        <Status ok={null} label="Allowed range" details={rangeD}
          detail={r.spec === "oxp3" ? `${r.pl1_min}–${r.pl1_max_battery} W on battery, up to ${r.pl1_max_ac} W plugged in` : `${r.pl1_min}–${r.pl1_max} W`} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const ImportSection: FC = () => {
  const act = useAction();
  const [lines, setLines] = useState<{ imported: string[]; skipped: string[] } | null>(null);
  const impD = det("Import from SimpleDeckyTDP", ["Copies SimpleDeckyTDP's default and per-game profiles into OXP3 Deck (a profile of the same game here is replaced). SimpleDeckyTDP's own files stay as they are.",
    "Then disable or uninstall SimpleDeckyTDP in Decky → Settings → Plugins and turn power control on."]);
  return (
    <PanelSection title="SimpleDeckyTDP">
      <PanelSectionRow>
        <WithDetails details={impD}>
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("import", async () => {
              if (!(await confirm({ title: "Import from SimpleDeckyTDP?", ok: "Import", effect: EFFECTS["power.import"],
                text: "Copies your SimpleDeckyTDP profiles into OXP3 Deck. A profile of the same game here is replaced. SimpleDeckyTDP's own files stay as they are.",
                linesTitle: "Technical:",
                lines: ["Its single TDP value becomes the sustained limit (PL1); boost stays at the device default.", "TDP, GPU clock range and CPU boost are copied."] }))) return null;
              await powerWriter.drain();
              const r = await power_import_sdtdp();
              if (r.ok) setLines({ imported: r.imported, skipped: r.skipped });
              return settle({ ...r, applied: null });
            })}
            description={explainWhen("Copies your SimpleDeckyTDP profiles.", EFFECTS["power.import"])}>
            {act.busy ? "Importing…" : label("Import from SimpleDeckyTDP", impD)}
          </ButtonItem>
        </WithDetails>
        {lines && <Status ok label={`Imported ${lines.imported.length}`}
          details={det(`Imported ${lines.imported.length}`, [lines.imported.join(", ") || "Nothing."])}
          detail="Now disable SimpleDeckyTDP in Decky's settings." />}
        {lines && lines.skipped.length > 0 && <Status ok={null} label={`Skipped ${lines.skipped.length}`}
          details={det(`Skipped ${lines.skipped.length}`, lines.skipped)} />}
        <Problem what="Import" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

/** "How often to check": poll_s over POLL_STEPS (index slider), sent 400 ms after the last move. */
const PollSlider: FC<{ info: PowerInfo }> = ({ info }) => {
  const act = useAction();
  const [draft, setDraft] = useState<number | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  const saved = typeof info.options.poll_s === "number" ? info.options.poll_s : POLL_DEFAULT;
  const value = draft ?? saved;
  const d = det("How often to check", [
    "How often OXP3 Deck checks that your power settings are still in place, and tries again what the device did not take (the GPU busy resetting or waking).",
    "Off: only after a game change, the charger or sleep. It never fights another program: when something else changes a setting, OXP3 Deck stops and says so.",
    `Default: every ${POLL_DEFAULT} s. Takes effect: Now.`,
  ]);
  const send = (v: number) => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => { t.current = null; act.run("poll", async () => {
      await powerWriter.drain(); const e = settle(await power_options({ poll_s: v })); setDraft(null); return e; }); }, 400);
  };
  return (
    <>
      <WithDetails details={d}>
        <SliderField label={label(`How often to check: ${pollText(value)}`, d)} value={pollIndex(value)} min={0} max={POLL_STEPS.length - 1} step={1}
          notchCount={POLL_STEPS.length} notchTicksVisible
          notchLabels={[{ notchIndex: 0, label: "Off", value: 0 }, { notchIndex: POLL_STEPS.length - 1, label: "60 s", value: POLL_STEPS.length - 1 }]}
          onChange={(i) => { const v = pollValue(i); setDraft(v); send(v); }}
          description={explainWhen("How often OXP3 Deck checks your settings are still in place.", EFFECTS["power.poll_s"])} />
      </WithDetails>
      <Problem what="How often to check" error={act.error} />
    </>
  );
};

const BatterySection: FC<{ x: ExtrasState | null }> = ({ x }) => {
  if (!x || (!x.charge.available && !(x.board_ok && !x.fan.available))) return null;
  return (
    <PanelSection title="Battery">
      <PanelSectionRow>
        <ChargeRows x={x} />
        <BatteryNote x={x} />
      </PanelSectionRow>
    </PanelSection>
  );
};

export const PowerTab: FC = () => {
  const p = usePower(true);
  const ex = useExtrasState();
  const s = p.state;
  if (!s || !p.info) {
    return (
      <PanelSection title="Power">
        <PanelSectionRow>
          {!p.error && <Status ok={null} label="Reading the power limits…" />}
          <Problem what="Power" error={p.error} />
        </PanelSectionRow>
      </PanelSection>
    );
  }
  return (
    <>
      <NowSection info={p.info} state={s} />
      <LiveSection active />
      <OptionsSection info={p.info} state={s} />
      <EditorSection info={p.info} state={s} x={ex.x} />
      <BatterySection x={ex.x} />
      <ConflictsSection info={p.info} x={ex.x} />
      <FirmwareSection info={p.info} state={s} />
      {p.info.sdtdp_found && <ImportSection />}
    </>
  );
};
