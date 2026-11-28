// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The Quick Access tab (original pages/Quick.tsx, quickgroups.ts): the status block, then one
 * collapsible group each for Live, This game, Power, CPU, Fan & battery, XeSS and Device fixes. A
 * closed group shows a one-line summary; its red alert is drawn before it (a closed section draws no
 * children), and nothing a closed group shows is read. Inside Steam (L3) this is the same tree.
 */
import { Callout, ListItem, Panel, Section, type Element, type QuickAccessTabContext } from "@bathysphere/sdk";
import { fit } from "../core/text";
import { info, isOxp3, onOxp3, platformLine } from "../device/info";
import { hw, notices, REVERT_TEXT } from "../hw/knobs";
import { auto } from "../games/autosetup";
import { fixState } from "../oxp3tool/state";
import { owedText } from "../power/selftest";
import { appName, currentGame } from "../games/running";
import { activeTarget, conflicts, power, profiles, refused, rulesError } from "../power/apply";
import { blocking, conflictText } from "../power/conflicts";
import { lastSample, liveLine } from "../power/live";
import { presetOf, PRESET_LABEL, slotValues } from "../power/profiles";
import { ruleTarget } from "../power/rules";
import { xess, xessLine } from "../xess/detect";
import { batteryControls } from "./battery";
import { cpuAlerts, cpuControls, cpuNowLine } from "./cpu";
import { fixesSummary, rebootRows, staleRows, toolRows } from "./fixes";
import { gameControls, tipRows } from "./game";
import { conflictRows, enableRows, helperRows, hwUnread, knobErrorRows, liveRowsView, lowRows, overrideRows, owedRows, powerControls, powerStatus, ruleProblems, targetName } from "./power";
import { groupOpen, GROUPS, prefs, type GroupId } from "./prefs";
import { Card, safeSection, Status, Unread } from "./rows";
import { autoSwitch, checkButton, xessOffer, xessStateRow, xessUpdate } from "./xess";
import { liveViews, loadBase, type View } from "./view";
import { catalog } from "../oxp3tool/catalog";
import { updates } from "../updates/check";
import { oxp3, versionNewer } from "../oxp3tool/state";

async function toggleGroup(id: GroupId, open: boolean): Promise<void> {
  await prefs.save({ ...prefs.value, groups: { ...prefs.value.groups, [id]: open } });
}

/** Device, platform, the gate, reboot warnings, the helper, update notices. */
function statusBlock(): Element[] {
  const i = info.value;
  const out: Element[] = [];
  if (!i) return [info.error ? <Unread what="This device" error={info.error} onRetry={() => info.invalidate()} /> : <Status label="Reading the device…" />];
  if (!isOxp3(i)) {
    out.push(
      <Callout title="Not an ONEXPLAYER 3" tone="warn" text="Power, fan, charging and device fixes are for the ONEXPLAYER 3 only; XeSS and per-game launch options still work." />,
      <Status label={fit(`${i.vendor || "?"} ${i.product || ""}`.trim())} line={platformLine(i)} more={[`Vendor: ${i.vendor || "(unreadable)"}`, `Product: ${i.product || "(unreadable)"}`, `Board: ${i.board || "(unreadable)"}`, "OXP3 Deck changes hardware only on a board named ONEXPLAYER 3 by ONE-NETBOOK."]} />,
    );
    return out;
  }
  out.push(<Status label="ONEXPLAYER 3" line={platformLine(i)} more={[`Product: ${i.product}`, `Board: ${i.board}`]} />);
  out.push(...rebootRows(oxp3.value));
  const helper = helperRows(hw.value);
  if (helper) out.push(helper);
  const up = xessUpdate(xess.value);
  if (up) out.push(<Status label={`XeSS ${up} is available`} line="XeSS group: update steps." tone="warn" />);
  const tool = updates.value.oxp3;
  if (tool && oxp3.value?.toolVersion && versionNewer(tool, oxp3.value.toolVersion)) out.push(<Status label={`oxp3-tool ${tool} is available`} line="Device fixes: install card." tone="warn" />);
  return out;
}

/** The red line a closed group still shows, else null (original Quick.tsx alerts). */
function alertOf(id: GroupId, game: { appid: number; name: string } | null): Element | null {
  const s = hw.value;
  const bad = (label: string, line?: string) => <ListItem label={fit(label)} {...(line ? { description: fit(line) } : {})} tone="bad" />;
  switch (id) {
    case "game": {
      const g = game && auto.value.on ? auto.value.games[String(game.appid)] : undefined;
      const rolled = (g?.changes ?? []).find((c) => c.state === "rolled_back");
      if (rolled) return bad("Undone after a quick exit", `${game!.name} closed within a minute after ${rolled.label}.`);
      return g?.lastError ? bad("Automatic setup: did not work", g.lastError) : null;
    }
    case "power": {
      const blockers = blocking(conflicts.value, power.value.ignored);
      if (refused.length && blockers.length) return bad(`Turn off ${blockers.map((c) => conflictText(c).name).join(" and ")} first`);
      // hostd keeps applying the profiles; the helper stops setting a knob it sees another program change
      if (power.value.enabled && blockers.length) return bad("Another program changes power limits", `${conflictText(blockers[0]!).name}: your limits may not hold. Turn it off.`);
      if (owedText().length) return bad("The device check did not put everything back", owedText().join(", "));
      if (s?.state.knobs.some((k) => ["tdp", "boost", "gpuRange"].includes(k.knob) && k.overridden)) return bad("Something changed your power limits", "Fix it, then Take control.");
      if (rulesError) return bad("Power: did not work", rulesError.line);
      if (profiles.value?.active.failed.length) return bad("Power: a value did not apply", profiles.value.active.failed[0]!.message);
      return null;
    }
    case "cpu":
      return s?.governor.value?.governor === "performance" ? bad("CPU speed policy is Performance") : null;
    case "battery": {
      const r = s?.fan.value?.reverted ?? (notices.get("fan")?.reason.startsWith("reverted-") ? notices.get("fan")!.reason : undefined);
      return r ? bad("Fan went back to Auto", `Because ${REVERT_TEXT[r] ?? r}.`) : null;
    }
    case "xess":
      return xess.value?.installed && xess.value.status.state === "failed" ? bad("XeSS fast mode: Off", "The fast driver failed its check.") : null;
    case "fixes": {
      const o = oxp3.value;
      if (!o) return null;
      const attention = Object.values(o.fixes).filter((f) => fixState(f) === "incomplete" || fixState(f) === "reverting").length;
      if (attention) return bad(`Fixes need attention (${attention})`, "Open the Fixes tab to finish or undo them.");
      return o.toolVersion ? null : bad("oxp3-tool not seen yet", "Needed for the controller, sleep and screen fixes.");
    }
    default:
      return null;
  }
}

function powerSummary(): string {
  const s = hw.value;
  if (!power.value.enabled) return "Off · device defaults";
  const t = ruleTarget(profiles.value?.active.rule) ?? activeTarget();
  const v = slotValues(power.value.profiles[t.key] ?? power.value.profiles.default!, t.slot);
  const tdp = s?.tdp.value;
  const preset = tdp && s ? presetOf(v, tdp.watts, { tdpMin: tdp.min, tdpMax: tdp.max, boostMin: s.boost.value?.min ?? 0, boostMax: s.boost.value?.max ?? tdp.max }, !!s.epp.value) : "custom";
  return fit([
    t.slot === "low" ? "Low battery" : null,
    preset !== "custom" && preset !== "default" ? PRESET_LABEL[preset] : null,
    tdp ? `${tdp.watts} W` : null,
    `boost ${v.boostW !== null ? `${v.boostW} W` : v.follow ? "follows" : "default"}`,
    v.gpuMaxMhz !== null ? `GPU ≤ ${v.gpuMaxMhz} MHz` : null,
    targetName({ key: t.key, slot: "main" }),
  ].filter(Boolean).join(" · "));
}

function batterySummary(): string {
  const s = hw.value;
  const fan = power.value.enabled ? (slotValues(power.value.profiles[activeTarget().key]!, activeTarget().slot).fan ?? "auto") : (s?.fan.value?.mode ?? "auto");
  const cl = s?.chargeLimit.value;
  return fit([
    s?.fan.value ? `Fan ${fan[0]!.toUpperCase()}${fan.slice(1)}` : null,
    cl ? (cl.percent >= 100 ? "Charges fully" : `Charge to ${cl.percent} %`) : null,
    s?.chargeBehaviour.value?.value === "inhibit-charge-awake" ? "Battery idle on charger" : null,
  ].filter(Boolean).join(" · ") || "Fan and battery");
}

/** The subtitle of a group: its one-line summary. */
function summaryOf(id: GroupId, game: { appid: number; name: string } | null): string {
  switch (id) {
    case "live":
      return liveLine(lastSample());
    case "game": {
      if (!game) return "No game running";
      const g = auto.value.on ? auto.value.games[String(game.appid)] : undefined;
      return fit([game.name, auto.value.on ? (g?.mode === "manual" ? "Manual" : "Automatic") : null, power.value.profiles[String(game.appid)] ? "Own power profile" : null].filter(Boolean).join(" · "));
    }
    case "power":
      return powerSummary();
    case "cpu":
      return hw.value ? fit(cpuNowLine(hw.value)) : "Reading…";
    case "battery":
      return batterySummary();
    case "xess": {
      const l = xessLine(xess.value);
      return fit(`${l.label.replace(/^XeSS fast mode: /, "")}${xessUpdate(xess.value) ? " · Update available" : ""}`);
    }
    case "fixes":
      return fixesSummary(oxp3.value);
  }
}

async function groupContent(v: View, id: GroupId, game: { appid: number; name: string } | null): Promise<Element[]> {
  const s = hw.value;
  const t = activeTarget();
  switch (id) {
    case "live":
      return liveRowsView(v, false);
    case "game":
      return game ? [autoSwitch(), ...(await gameControls(game.appid, game.name, false)), ...tipRows(game.appid)] : [];
    case "power":
      if (!s) return [hwUnread()];
      return [powerStatus(s), ...lowRows(), ...owedRows(), ...enableRows(), ...conflictRows(false), ...(power.value.enabled ? powerControls(v, s, t) : []), ...knobErrorRows(s, ["tdp", "boost", "gpuRange"]), ...overrideRows(s, ["tdp", "boost", "gpuRange"]), ...ruleProblems()];
    case "cpu":
      if (!s) return [hwUnread()];
      return [...cpuAlerts(s), ...(power.value.enabled ? cpuControls(v, s, t, false) : [<Status label="CPU" line="Turn on power control to set CPU limits per profile." />]), <Status label="CPU now" line={cpuNowLine(s)} />, ...knobErrorRows(s, ["cpuLimits", "epp", "energy", "socBalance", "cpuBoost", "gpuPowerProfile"]), ...overrideRows(s, ["epp", "cpuLimits", "socBalance"])];
    case "battery":
      return s ? batteryControls(s, t) : [hwUnread()];
    case "xess":
      return [xessStateRow(xess.value), ...xessOffer(xess.value), ...checkButton()];
    case "fixes": {
      await catalog.load();
      const o = oxp3.value;
      if (!o && oxp3.error) return [<Unread what="oxp3-tool's state" error={oxp3.error} onRetry={() => oxp3.invalidate()} />];
      return [...rebootRows(o), ...(o?.toolVersion ? [] : toolRows(o)), ...staleRows(o, catalog.value), <Card id="oxp3-tool-apply" />, <Status label="All fixes" line="Bathysphere Home → OXP3 Deck → Fixes and Buttons." />];
    }
  }
}

export async function renderQam(ctx: QuickAccessTabContext): Promise<Element> {
  const v: View = { where: "qam", key: `quickAccessTab:${ctx.id}:${ctx.inst}`, appid: ctx.appid ?? currentGame() };
  await loadBase();
  const oxp = onOxp3();
  const game = v.appid !== null ? { appid: v.appid, name: appName(v.appid) } : null;
  const children: Array<Element | null> = [await safeSection("Status", () => <>{statusBlock()}</>)];
  liveViews.delete(v.key);
  // the Live header's summary reads the sensors too, open or closed, while this tab shows
  if (oxp) liveViews.set(v.key, { gpuClocks: false });
  for (const g of GROUPS) {
    if (!oxp && (g.id === "power" || g.id === "cpu" || g.id === "battery" || g.id === "fixes")) continue;
    if (g.id === "game" && !game) continue;
    const open = groupOpen(g.id);
    const alert = oxp || g.id === "game" ? alertOf(g.id, game) : null;
    if (!open && alert) children.push(alert);
    const content = open ? await safeSection(g.title, async () => <>{await groupContent(v, g.id, game)}</>) : null;
    children.push(
      <Section key={`g-${g.id}`} title={g.title} subtitle={summaryOf(g.id, game)} collapsible defaultOpen={open} onToggle={(o) => toggleGroup(g.id, o)}>
        {content}
      </Section>,
    );
  }
  children.push(<Callout text="All settings: OXP3 Deck in Bathysphere Home." tone="neutral" />);
  return <Panel title="OXP3 Deck">{children}</Panel>;
}
