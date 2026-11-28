// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The full page in Bathysphere Home (original pages/Full.tsx): tabs Power, CPU & GPU, Fan &
 * battery, Games, XeSS, Fixes, Buttons, Kernel (CachyOS only) and Setup & updates. On another device
 * only Games, XeSS and Setup & updates.
 */
import { Callout, Panel, Section, Select, Tabs, Text, type Element, type PanelContext } from "@bathysphere/sdk";
import type { Stored } from "../core/storage";
import { fit } from "../core/text";
import { info, isCachyOs, onOxp3 } from "../device/info";
import { hw } from "../hw/knobs";
import { appName, currentGame, library } from "../games/running";
import { power } from "../power/apply";
import { catalog } from "../oxp3tool/catalog";
import { batteryControls } from "./battery";
import { cpuAlerts, cpuControls, cpuNowLine, schedulerRows } from "./cpu";
import { buttonsTab, fixesTab, kernelTab } from "./fixes";
import { gameControls, tipRows } from "./game";
import { acLimitLine, checkRows, conflictRows, editorRows, enableRows, helperRows, hwUnread, knobErrorRows, liveRowsView, lowRows, optionRows, overrideRows, powerControls, powerExtras, powerStatus, rangeRows, ruleProblems, targetName } from "./power";
import { prefs, type TabId } from "./prefs";
import { safeSection, Status, Unread } from "./rows";
import { setupTab } from "./setup";
import { autoSwitch, xessTab } from "./xess";
import { liveViews, loadBase, setState, stateOf, type View } from "./view";

const TAB_LABEL: Record<TabId, string> = {
  power: "Power",
  cpu: "CPU & GPU",
  battery: "Fan & battery",
  games: "Games",
  xess: "XeSS",
  fixes: "Fixes",
  buttons: "Buttons",
  kernel: "Kernel",
  setup: "Setup & updates",
};

function tabsHere(): TabId[] {
  if (!onOxp3()) return ["games", "xess", "setup"];
  return ["power", "cpu", "battery", "games", "xess", "fixes", "buttons", ...(isCachyOs(info.value) ? (["kernel"] as TabId[]) : []), "setup"];
}

async function powerTab(v: View): Promise<Element[]> {
  const s = hw.value;
  const helper = helperRows(s);
  if (!s) return [hwUnread()];
  const out: Element[] = [powerStatus(s), ...lowRows(), ...(helper ? [helper] : []), ...enableRows(), ...knobErrorRows(s, ["tdp", "boost", "gpuRange"]), ...ruleProblems()];
  out.push(<Section title="Live">{liveRowsView(v, true)}</Section>);
  if (power.value.enabled) {
    const ed = editorRows(v);
    out.push(<Section title="Profile">{ed.rows}</Section>, <Section title="Values">{[...powerControls(v, s, ed.target), ...powerExtras(v, s, ed.target)]}</Section>);
  }
  out.push(<Section title="Options">{optionRows(s, await acLimitLine())}</Section>);
  out.push(<Section title="Other power programs">{[...conflictRows(true), ...overrideRows(s, ["tdp", "boost", "gpuRange"])]}</Section>);
  out.push(<Section title="This device">{[...rangeRows(s), ...checkRows()]}</Section>);
  return out;
}

function cpuTab(v: View): Element[] {
  const s = hw.value;
  if (!s) return [hwUnread()];
  const out: Element[] = [...cpuAlerts(s), <Status label="CPU now" line={cpuNowLine(s)} />, ...knobErrorRows(s, ["cpuLimits", "epp", "energy", "socBalance", "cpuBoost", "gpuPowerProfile", "governor"])];
  if (power.value.enabled) {
    const ed = editorRows(v);
    out.push(<Text variant="caption" text={`Edits: ${targetName(ed.target)} (choose the profile on the Power tab)`} />, ...cpuControls(v, s, ed.target, true));
  } else out.push(<Status label="Turn on power control (Power tab) to set CPU and GPU limits per profile." />);
  out.push(...overrideRows(s, ["epp", "cpuLimits", "socBalance", "energy"]), ...schedulerRows());
  return out;
}

function batteryTab(v: View): Element[] {
  const s = hw.value;
  return s ? batteryControls(s, editorRows(v).target) : [hwUnread()];
}

/** The game the Games tab shows: the one on screen or running, else the last one, else the picked one. */
async function gamesTab(v: View, ctxAppid: number | undefined): Promise<Element[]> {
  const picked = stateOf<number | null>(v, "game", null);
  const appid = ctxAppid ?? picked ?? prefs.value.lastGame?.appid ?? null;
  const out: Element[] = [autoSwitch()];
  if (!library.value && library.error) out.push(<Unread what="Steam library" error={library.error} onRetry={() => library.invalidate()} />);
  const lib = (library.value ?? []).slice(0, 63);
  if (lib.length) {
    out.push(
      <Select
        label="Game"
        options={[{ value: "", label: appid !== null ? fit(appName(appid), 60) : "Pick a game" }, ...lib.filter((a) => a.appid !== appid).map((a) => ({ value: String(a.appid), label: fit(a.name, 60) }))]}
        value=""
        onChange={(x) => {
          if (x) setState(v, "game", Number(x));
        }}
      />,
    );
  }
  if (appid === null) return [...out, <Status label="No game running" line="Start one, or pick one above." />];
  const name = appName(appid, prefs.value.lastGame?.appid === appid ? prefs.value.lastGame.name : null);
  out.push(<Text variant="heading" text={fit(name, 80)} />, ...(await gameControls(appid, name, true)), ...tipRows(appid));
  return out;
}

export async function renderPanel(ctx: PanelContext, stores: ReadonlyArray<Stored<unknown>>): Promise<Element> {
  const v: View = { where: "panel", key: `panel:${ctx.id}:${ctx.inst}`, appid: ctx.appid ?? currentGame() };
  await loadBase();
  liveViews.delete(v.key);
  const tabs = tabsHere();
  let tab = stateOf<TabId>(v, "tab", prefs.value.tab);
  if (!tabs.includes(tab)) tab = tabs.includes("power") ? "power" : "games";
  const content = await safeSection(TAB_LABEL[tab], async () => {
    switch (tab) {
      case "power":
        return <>{await powerTab(v)}</>;
      case "cpu":
        return <>{cpuTab(v)}</>;
      case "battery":
        return <>{batteryTab(v)}</>;
      case "games":
        return <>{await gamesTab(v, ctx.appid)}</>;
      case "xess":
        return <>{xessTab()}</>;
      case "fixes":
        await catalog.load();
        return <>{fixesTab(v)}</>;
      case "buttons":
        await catalog.load();
        return <>{buttonsTab(v)}</>;
      case "kernel":
        return <>{kernelTab(v)}</>;
      case "setup":
        return <>{await setupTab(stores)}</>;
    }
  });
  return (
    <Panel title="OXP3 Deck">
      {!onOxp3() && info.value ? <Callout title="Not an ONEXPLAYER 3" tone="warn" text={`This is ${fit(`${info.value.vendor} ${info.value.product}`.trim() || "another device", 60)}: OXP3 Deck changes no hardware here. XeSS and per-game launch options work.`} /> : null}
      <Tabs
        tabs={tabs.map((id) => ({ id, label: TAB_LABEL[id] }))}
        value={tab}
        onChange={async (id) => {
          setState(v, "tab", id);
          await prefs.save({ ...prefs.value, tab: id as TabId });
        }}
      >
        {content}
      </Tabs>
    </Panel>
  );
}
