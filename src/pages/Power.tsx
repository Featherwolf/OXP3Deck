// The full page's Power tab (DESIGN.md "Power (TDP, GPU, CPU)", Frontend): the live state per RAPL zone, the options,
// the profile editor for every profile, the other power managers found, the firmware values and the import from
// SimpleDeckyTDP.
import { ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { FC, useEffect, useState } from "react";

import { useAction } from "../actions";
import { power_import_sdtdp, power_info, power_options, power_profile } from "../backend";
import { confirm } from "../components/confirm";
import { explain, Note, Problem, Status } from "../components/Hint";
import { EnableToggle, PowerStatusRows, settle, usePower, ValuesEditor } from "../components/PowerControls";
import { eppText, profileOrder, reasonText, Slot, watts } from "../power";
import { useRunningApp } from "../steam";
import { flushPower, powerWriter, put } from "../store";
import type { PowerInfo, PowerOptions, PowerState, PowerZone } from "../types";
import { when } from "../util";

const zoneText = (z: PowerZone) => {
  const lock = (c: string) => (z.locked.includes(c) ? " (locked)" : "");
  return `PL1 ${watts(z.pl1_w)}${lock("pl1")} · PL2 ${watts(z.pl2_w)}${lock("pl2")} · PL4 ${watts(z.pl4_w)}`;
};
const zoneName = (z: PowerZone) => `${z.iface === "mmio" ? "MMIO" : "MSR"} ${z.name}`;
const onOff = (b: boolean | null | undefined) => (b == null ? "?" : b ? "on" : "off");

const NowSection: FC<{ info: PowerInfo | null; state: PowerState }> = ({ info, state }) => {
  const n = state.now;
  // MSR and MMIO side by side: the hardware uses the lower of the two
  const zones = [...n.zones].sort((a, b) => (a.iface === b.iface ? a.id.localeCompare(b.id) : a.iface === "msr" ? -1 : 1));
  return (
    <PanelSection title="Status">
      <PowerStatusRows info={info} state={state} />
      <PanelSectionRow>
        {zones.map((z) => (
          <Field key={z.id} focusable bottomSeparator="none" label={zoneName(z)}
            description={explain(zoneText(z), z.iface === "mmio" ? "Firmware rewrites these on every AC change; OXP3 Deck writes them again." : "The GPU follows this PL1.")} />
        ))}
        {!zones.length && <Note>No RAPL power-limit zones were found: the power limits cannot be read or set here.</Note>}
        {n.gpu && (
          <Field focusable bottomSeparator="none" label={`GPU ${n.gpu.act ?? "?"} MHz`}
            description={explain(`Range now ${n.gpu.min ?? "?"}–${n.gpu.max ?? "?"} MHz.`,
              reasonText(n.gpu.reasons) ? `Throttled: ${reasonText(n.gpu.reasons)} (${n.gpu.reasons.join(", ")}).` : "Not throttled.")} />
        )}
        <Field focusable bottomSeparator="none" label="CPU"
          description={`Energy preference ${eppText(n.epp)} · boost ${onOff(n.turbo)} · governor ${n.governor ?? "?"} · ${state.active.ac == null ? "power source unknown" : state.active.ac ? "on AC" : "on battery"}`} />
        {state.enabled && state.cpu_blocked && <Status ok={false} label="Energy preference and CPU boost are not set" detail={state.cpu_blocked} />}
      </PanelSectionRow>
    </PanelSection>
  );
};

const OptionsSection: FC<{ info: PowerInfo; state: PowerState }> = ({ info, state }) => {
  const act = useAction();
  const set = (name: string, o: Partial<PowerOptions>) => act.run(name, async () => { await powerWriter.drain(); return settle(await power_options(o)); });
  const r = state.range;
  return (
    <PanelSection title="Control">
      <EnableToggle state={state} info={info} />
      <PanelSectionRow>
        <ToggleField label="Per-game profiles" checked={info.options.per_game} disabled={!!act.busy}
          onChange={(c) => set("per_game", { per_game: c })}
          description={explain("A game with a profile of its own runs with it; every other game with the default profile.",
            "Off: every game runs with the default profile (game profiles are kept).")} />
        <ToggleField label="Separate values on AC" checked={info.options.split_ac} disabled={!!act.busy}
          onChange={(c) => set("split_ac", { split_ac: c })}
          description={explain("Each profile gets a second set of values used while the charger is plugged in.",
            "Switches within a few seconds of plugging in or out.")} />
        {r.extended_max != null && (
          <ToggleField label={`Allow more than ${r.pl1_max_ac} W on AC`} checked={info.options.extended} disabled={!!act.busy}
            onChange={(c) => set("extended", { extended: c })}
            description={explain(`Raises the sustained limit on AC up to ${r.extended_max} W, the firmware's own boost limit. ONEXPLAYER rates the OXP3 for ${r.pl1_max_battery} W sustained, up to ${r.pl1_max_ac} W.`,
              "Use a charger of 65 W or more: a weaker one cannot keep up and the battery drains or the charge flaps on and off.",
              "On battery the limit stays at " + `${r.pl1_max_battery} W.`)} />
        )}
        <Problem what="Option" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const EditorSection: FC<{ info: PowerInfo; state: PowerState }> = ({ info, state }) => {
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
  return (
    <PanelSection title="Profiles">
      <PanelSectionRow>
        <DropdownItem label="Profile" rgOptions={order.map((o) => ({ data: o.key, label: o.label }))} selectedOption={k}
          onChange={(o) => setKey(String(o.data))}
          description={explain(`${state.active.key === k ? "Active now." : "Not active now: changes are saved and apply when it is."}`,
            info.options.per_game ? undefined : "Per-game profiles are off: every game uses the default profile.")} />
        {info.options.split_ac && (
          <DropdownItem label="Values for" rgOptions={[{ data: "main", label: "Battery" }, { data: "ac", label: "On AC" }]}
            selectedOption={slot} onChange={(o) => setSlotPick(o.data as Slot)}
            description={slot === "ac" && !prof.ac ? "No AC values yet: they start as a copy of the battery values at the first change." : "Which of the profile's two sets these controls edit."} />
        )}
        {!state.enabled && <Note>TDP control is off: profile changes are saved and apply once it is on.</Note>}
      </PanelSectionRow>
      <ValuesEditor key={`${k}/${slot}`} state={state} info={info} profileKey={k} slot={slot} stored={stored} active={active && state.enabled}
        label={`${name}${info.options.split_ac ? (slot === "ac" ? " (AC values)" : " (battery values)") : ""}`} />
      <PanelSectionRow>
        {canAdd && (
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("add", async () => { await powerWriter.drain(); const e = settle(await power_profile(app.appid, app.name, true)); if (!e) setKey(app.appid); return e; })}
            description={`${app.name} gets its own profile, starting as a copy of the default.`}>
            New profile for {app.name}
          </ButtonItem>
        )}
        {k !== "default" && (
          <ButtonItem layout="below" disabled={!!act.busy}
            onClick={() => act.run("delete", async () => {
              if (!(await confirm({ title: "Delete profile", ok: "Delete", destructive: true,
                text: `${prof.name || `App ${k}`} then runs with the default profile.` }))) return null;
              await powerWriter.drain();
              const e = settle(await power_profile(k, null, false));
              if (!e) setKey("default");
              return e;
            })}
            description="The game runs with the default profile again.">
            Delete profile
          </ButtonItem>
        )}
        <Problem what="Profile" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const ConflictsSection: FC<{ info: PowerInfo }> = ({ info }) => {
  const act = useAction();
  const ignore = (id: string) => act.run(id, async () => { await powerWriter.drain(); return settle(await power_options({ ignore: [...info.options.ignore.filter((x) => x !== id), id] })); });
  return (
    <PanelSection title="Other power managers">
      <PanelSectionRow>
        {!info.conflicts.length && <Status ok label="None found" detail="No other program that sets the power limits, GPU clocks or EPP runs." />}
        {info.conflicts.map((c) => (
          <div key={c.id}>
            <Status ok={c.ignored ? null : false} label={`${c.name}${c.ignored ? " (you said it is handled)" : c.kind === "cpu" ? ": EPP and CPU boost left to it" : c.kind === "suspect" ? "" : ": blocks TDP control"}`}
              detail={explain(c.why, c.fix ? <>Fix: {c.fix}</> : undefined)} />
            {c.ignorable && !c.ignored && (
              <ButtonItem layout="below" disabled={!!act.busy} onClick={() => ignore(c.id)}
                description={`Only once ${c.name} no longer sets these values: OXP3 Deck then stops counting it.`}>
                I have done that
              </ButtonItem>
            )}
          </div>
        ))}
        <ButtonItem layout="below" disabled={!!act.busy}
          onClick={() => act.run("check", async () => {
            const r = await power_info(true);
            if (r.ok) put("power-info", r);
            return r.ok ? null : r.error;
          })}
          description="Looks for other power managers again (services, programs, Decky plugins).">
          {act.busy === "check" ? "Checking…" : "Check again"}
        </ButtonItem>
        <Problem what="Conflicts" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const FirmwareSection: FC<{ info: PowerInfo; state: PowerState }> = ({ info, state }) => {
  const r = state.range;
  return (
    <PanelSection title="Firmware values">
      <PanelSectionRow>
        <Note>{info.boot ? `The values when TDP control was first enabled this boot (read at ${when(info.boot.taken_at)}): another tool's leftovers show here too; a reboot gives the firmware's own. Boost is the highest of the interfaces. Turning TDP control off restores these.`
          : "Not read yet: OXP3 Deck reads them when TDP control first writes this boot. Turning TDP control off restores them."}</Note>
        <Note>Before you disable or uninstall OXP3 Deck (e.g. to go back to SimpleDeckyTDP), turn TDP control off: the GPU clock range and energy preference it set otherwise stay until a reboot.</Note>
        {state.now.zones.map((z) => (
          <Field key={z.id} focusable bottomSeparator="none" label={zoneName(z)}
            description={`PL1 ${watts(z.boot_pl1_w)} · PL2 ${watts(z.boot_pl2_w)}${z.pl1_base_w ? ` · base power ${watts(z.pl1_base_w)}` : ""}`} />
        ))}
        {r.gpu_min != null && (
          <Field focusable bottomSeparator="none" label="GPU clock range"
            description={`${r.gpu_min}–${r.gpu_max} MHz${r.gpu_efficient ? `, most efficient at ${r.gpu_efficient} MHz` : ""}${info.hw.gpu ? ` (${info.hw.gpu.card}, ${info.hw.gpu.gt})` : ""}`} />
        )}
        <Field focusable bottomSeparator="none" label="Range OXP3 Deck allows"
          description={r.spec === "oxp3"
            ? `Sustained ${r.pl1_min}–${r.pl1_max_battery} W on battery, up to ${r.pl1_max_ac} W on AC${r.extended_max ? ` (${r.extended_max} W with the option above)` : ""}; boost up to ${r.pl2_max} W. ONEXPLAYER's own figures for the OXP3.`
            : `Sustained ${r.pl1_min}–${r.pl1_max} W, boost up to ${r.pl2_max} W: never above what this device's firmware set.`} />
      </PanelSectionRow>
    </PanelSection>
  );
};

const ImportSection: FC = () => {
  const act = useAction();
  const [lines, setLines] = useState<{ imported: string[]; skipped: string[] } | null>(null);
  return (
    <PanelSection title="SimpleDeckyTDP">
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!act.busy}
          onClick={() => act.run("import", async () => {
            if (!(await confirm({ title: "Import from SimpleDeckyTDP", ok: "Import",
              text: "Copies SimpleDeckyTDP's default and per-game TDP, GPU clock and CPU boost values into OXP3 Deck's profiles (a profile of the same game here is replaced). SimpleDeckyTDP's own files stay as they are. Its single TDP value becomes the sustained limit; boost stays at the firmware's." }))) return null;
            await powerWriter.drain();
            const r = await power_import_sdtdp();
            if (r.ok) setLines({ imported: r.imported, skipped: r.skipped });
            return settle({ ...r, applied: null });
          })}
          description={explain("Takes over the profiles you made in SimpleDeckyTDP.",
            "Then disable or uninstall SimpleDeckyTDP in Decky's settings (Plugins) and turn TDP control on.")}>
          {act.busy ? "Importing…" : "Import from SimpleDeckyTDP"}
        </ButtonItem>
        {lines && <Note label={`Imported ${lines.imported.length}`}>{lines.imported.join(", ") || "nothing"}</Note>}
        {lines && lines.skipped.length > 0 && <Note label={`Skipped ${lines.skipped.length}`}>{lines.skipped.join("; ")}</Note>}
        <Problem what="Import" error={act.error} />
      </PanelSectionRow>
    </PanelSection>
  );
};

export const PowerTab: FC = () => {
  const p = usePower(true);
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
      <OptionsSection info={p.info} state={s} />
      <EditorSection info={p.info} state={s} />
      <ConflictsSection info={p.info} />
      <FirmwareSection info={p.info} state={s} />
      {p.info.sdtdp_found && <ImportSection />}
    </>
  );
};
