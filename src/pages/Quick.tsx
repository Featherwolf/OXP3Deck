// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// Based on ClawDeck's QuickPanel (src/pages.tsx): the Quick Access panel.
// Short: the state of the device without a header, then groups that A opens and closes (DESIGN.md "Quick Access
// groups"): Live, This game, Power, CPU, Fan & battery, XeSS, Device fixes. A closed group shows a summary and its
// red rows; everything else is on the full page ("All settings").
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { FC, useEffect } from "react";

import { applyFixes, blockedBy, fixesEffect, installOxp3, installXess, useAction } from "../actions";
import { rollbackText } from "../autosetup";
import { useAutoState } from "../autostate";
import { get_overview, oxp3_status, xess_check_update, xess_state } from "../backend";
import { friendlyName } from "../conflicts";
import { AutoSetupRows, AutoSetupSwitch, rolledBackRows } from "../components/AutoSetup";
import { clearRecentFixes } from "../components/ConflictRow";
import { useExtrasState } from "../components/ExtrasControls";
import { GameControls } from "../components/GameControls";
import { clearPinned, Group } from "../components/Group";
import { DetailsSpec, paragraphs } from "../components/confirm";
import { explain, explainWhen, INFO, Note, Problem, Status, WithDetails } from "../components/Hint";
import { EFFECTS } from "../effects";
import { JobView, useQuickAccessVisible } from "../components/JobView";
import { LiveRows } from "../components/LiveRows";
import {
  BatteryBody, CpuAlerts, CpuBody, GameProfileToggle, PowerAlerts, PowerBody, usePower, useRefused,
} from "../components/PowerControls";
import { RebootRow } from "../components/Reboot";
import { openPage } from "../nav";
import {
  Alert, alertOf, batteryAlert, batterySummary, cpuAlert, cpuSummary, editedSlot, editedValues, fixesSummary, gameSummary,
  liveSummary, powerAlert, powerSummary, refusedLive, xessLine, xessSummary,
} from "../quickgroups";
import { useRunningApp } from "../steam";
import { syncJob, useCurrentJob, useLive, useResource } from "../store";
import { firstSentence, fitsOneLine } from "../text";
import type { Overview, Oxp3Install, Oxp3Status, StatusRes, XessStateRes, XessUpdateCheck } from "../types";
import { atLeast, cmpVersion, listText, platformName } from "../util";
import { checkText, offerLabel, repairText, xessOffer } from "../xessoffer";

export { xessLine };

/** oxp3-tool is there and new enough for --json; otherwise nothing but the install button works. */
export const oxp3Usable = (i: Oxp3Install | null | undefined) =>
  !!i?.installed && i.json_ok && atLeast(i.version, i.min_version);

/** What the oxp3-tool section offers: install, update to the plugin's copy, or nothing. */
export const oxp3Offer = (i: Oxp3Install | null | undefined): { source: "bundled" | "online"; version: string | null; update: boolean } | null => {
  if (!i) return null;
  const source = i.bundled_version ? "bundled" : "online";
  if (!i.installed) return { source, version: i.bundled_version, update: false };
  if (!oxp3Usable(i)) return { source, version: i.bundled_version, update: true };
  if (i.bundled_version && i.version && cmpVersion(i.bundled_version, i.version) > 0) {
    return { source: "bundled", version: i.bundled_version, update: true };
  }
  return null;
};

const StatusSection: FC<{ o: Overview | null; err: string | null; st: Oxp3Status | null }> = ({ o, err, st }) => {
  const os = st ? `${st.os.name ?? platformName(st.os.platform)}${st.os.kernel ? `, kernel ${st.os.kernel}` : ""}` : platformName(o?.platform);
  return (
    <PanelSection>
      <PanelSectionRow>
        {o && (
          <Status ok={o.device.supported} label={o.device.supported ? "ONEXPLAYER 3" : "Not a ONEXPLAYER 3"}
            detail={st?.os.name ?? platformName(o.platform)}
            details={{ title: o.device.supported ? "ONEXPLAYER 3" : "Not a ONEXPLAYER 3", body: `${o.device.product ?? "Unknown device"} · ${os}. The fixes support the ONEXPLAYER 3 on Bazzite and CachyOS.`,
              lines: [`vendor: ${o.device.vendor ?? "?"}`, `product: ${o.device.product ?? "?"}`] }} />
        )}
        {!o && !err && <Status ok={null} label="Reading the state…" />}
        <Problem what="Status" error={err} />
      </PanelSectionRow>
      <RebootRow o={o} st={st} />
      <JobView quick />
    </PanelSection>
  );
};

/** The fixes the oxp3-tool status lists, by state. */
const fixCounts = (st: StatusRes | undefined) => {
  const fixes = st?.ok ? st.status?.fixes ?? [] : [];
  return {
    recommended: fixes.filter((f) => f.state === "recommended"),
    attention: fixes.filter((f) => f.state === "damaged" || f.state === "incomplete"),
    applied: fixes.filter((f) => f.state === "applied").length,
  };
};

/** The Device fixes group; only="alerts": the fixes tool missing or too old, warnings and attention (closed). */
const Oxp3Section: FC<{ o: Overview; st: StatusRes | undefined; loading: boolean; only?: "alerts" }> = ({ o, st, loading, only }) => {
  const act = useAction();
  const inst = useAction();     // its own, so its error shows under it also while oxp3-tool is missing (FE-2)
  const job = useCurrentJob();
  const running = job?.state === "running";
  const i = o.oxp3;
  const offer = oxp3Offer(i);
  const usable = oxp3Usable(i);
  const status = st?.ok ? st.status : null;
  const { recommended, attention, applied } = fixCounts(st);
  const full = only !== "alerts" || !usable;       // closed: the status line and its button only while it is missing or old
  const recD: DetailsSpec = {
    title: `Recommended fixes (${recommended.length})`,
    body: paragraphs(recommended.map((f) => `${f.title}: ${f.summary}. Takes effect ${f.takes_effect}.`)),
  };
  const applyD: DetailsSpec = {
    title: `Apply recommended (${recommended.length})`,
    body: `Applies ${recommended.length === 1 ? "this fix" : `these ${recommended.length} fixes`}. You see the plan first.${recommended.some((f) => /reboot/i.test(f.takes_effect)) ? " Some take effect after a reboot." : ""}`,
  };
  const instD: DetailsSpec | null = offer ? {
    title: `${offer.update ? "Update" : "Install"} fixes tool`,
    body: `The fixes tool (oxp3-tool) does the controller, sleep and screen fixes. ${offer.update ? "Updates" : "Installs"} it${offer.version ? ` to ${offer.version}` : ""} ${offer.source === "bundled" ? "from the copy in this plugin" : "from GitHub"}. Takes a few seconds; asks first.`,
    lines: ["/usr/local/bin/oxp3-tool"],
  } : null;
  return (
    <>
      <PanelSectionRow>
        {full && <Status ok={usable ? true : false}
          label={!i.installed ? "Fixes tool not installed" : usable ? "Device fixes" : "Fixes tool too old"}
          detail={!i.installed ? "Needed for controller, sleep and screen fixes"
            : !usable ? "Update it to use the fixes."
            : status ? `${applied} fix${applied === 1 ? "" : "es"} applied${status.can_change ? "" : " · this system is not supported"}` : loading ? "Reading…" : undefined}
          details={{ title: "Fixes tool (oxp3-tool)", body: `OXP3 Deck needs ${i.min_version} or newer.${status && !status.can_change ? " This system is not supported, so nothing can be changed." : ""}`,
            lines: [`installed: ${i.version ?? "none"}`, `path: ${i.path ?? "/usr/local/bin/oxp3-tool"}`] }} />}
        {offer && full && (
          <WithDetails details={instD}>
            <ButtonItem layout="below" disabled={!!inst.busy || !!act.busy || running}
              onClick={() => inst.run("oxp3-tool", async () => blockedBy() ?? installOxp3(offer.source, offer.version, offer.update))}
              description={explainWhen("Takes a few seconds.", EFFECTS["oxp3.install"], running ? "Wait for the running task." : null)}>
              {inst.busy ? "Working…" : `${offer.update ? "Update" : "Install"} fixes tool${INFO}`}
            </ButtonItem>
          </WithDetails>
        )}
        <Problem what={offer?.update ? "Update fixes tool" : "Install fixes tool"} error={inst.busy ? null : inst.error} />
        {usable && st && !st.ok && <Problem what="Fixes status" error={st.error} />}
      </PanelSectionRow>
      {usable && status && (
        <PanelSectionRow>
          {status.warnings.map((w, n) => <Status key={n} ok={false} label="Warning" detail={firstSentence(w)}
            details={fitsOneLine(w) ? null : { title: "Warning", body: w }} />)}
          {recommended.length > 0 && only !== "alerts" && (
            <Status ok={null} label={`Recommended fixes (${recommended.length})`} details={recD}
              detail={firstSentence(recommended.map((f) => f.title).join(", "))} />
          )}
          {recommended.length > 0 && status.can_change && only !== "alerts" && (
            <WithDetails details={applyD}>
              <ButtonItem layout="below" disabled={!!act.busy || !!inst.busy || running}
                onClick={() => act.run("apply", async () => blockedBy() ?? applyFixes(recommended, {}, "Apply the recommended fixes"))}
                description={explainWhen("Shows what will change before anything happens.", fixesEffect(recommended), running ? "Wait for the running task." : null)}>
                {act.busy === "apply" ? "Reading the plan…" : `Apply recommended (${recommended.length})${INFO}`}
              </ButtonItem>
            </WithDetails>
          )}
          {recommended.length === 0 && attention.length === 0 && only !== "alerts" && <Status ok label="Fixes up to date" />}
          {attention.length > 0 && (
            <WithDetails details={{ title: "Fixes need attention", body: listText(attention.map((f) => f.title)) }}>
              <ButtonItem layout="below" onClick={() => openPage("fixes")}
                description={explain("Open the Fixes tab to repair them.")}>
                {`Fixes need attention (${attention.length})${INFO}`}
              </ButtonItem>
            </WithDetails>
          )}
          <Problem what="Apply" error={act.busy ? null : act.error} />
        </PanelSectionRow>
      )}
    </>
  );
};

/** The Device fixes group's alert: the fixes tool missing or too old, a warning, fixes that need attention. */
const fixesAlert = (o: Overview, st: StatusRes | undefined): Alert | null => {
  const i = o.oxp3;
  const usable = oxp3Usable(i);
  const status = st?.ok ? st.status : null;
  const { attention } = fixCounts(st);
  return alertOf([
    !i.installed && { label: "Fixes tool not installed", line: "Needed for controller, sleep and screen fixes" },
    i.installed && !usable && { label: "Fixes tool too old", line: "Update it to use the fixes." },
    usable && !!status?.warnings.length && { label: "Warning", line: firstSentence(status.warnings[0]) },
    usable && attention.length > 0 && { label: `Fixes need attention (${attention.length})`, line: "Open the Fixes tab to repair them." },
    usable && !!st && !st.ok && { label: "Fixes status: did not work", line: firstSentence(st.error) },
  ]);
};

const XessSection: FC<{ o: Overview }> = ({ o }) => {
  const act = useAction();
  const job = useCurrentJob();
  const xs = useResource<XessStateRes>("xess", xess_state);
  const chk = useResource<XessUpdateCheck>("manual:xess-check", xess_check_update, { skip: true });
  const line = xessLine(o.xess);
  const x = xs.data?.xess ?? null;
  // the button and its confirmation both go by the overview's summary (FE-4); only a newer tag is an update (FE-1)
  const offer = xessOffer(o.xess.installed, o.xess.version, x, chk.data);
  const busy = !!act.busy || job?.state === "running";
  const game = useRunningApp();        // the installer is refused while a game runs
  return (
    <>
      <PanelSectionRow>
        <Status ok={line.ok} label={line.label} detail={line.detail} details={{ title: "XeSS fast mode", body: line.more, lines: o.xess.line ? [o.xess.line] : undefined }} />
        {offer.kind ? (
          <WithDetails details={{ title: offerLabel(offer), body: offer.kind === "update" ? `Updates xess-xmx-linux ${o.xess.version ?? ""} to ${offer.latest}. Then log out and back in; asks first.`
            : offer.kind === "repair" ? `${repairText(offer)} Asks first.`
            : "Installs xess-xmx-linux (XeSS upscaling and frame generation on the XMX cores) from GitHub. Then log out and back in; asks first." }}>
            <ButtonItem layout="below" disabled={busy || !!game}
              onClick={() => act.run("xess", async () => blockedBy() ?? installXess(offer, x, o.user))}
              description={explainWhen(offer.kind === "repair" ? "Runs the installer again." : "Faster XeSS upscaling and frame generation in games.",
                offer.kind === "update" ? EFFECTS["xess.update"] : offer.kind === "repair" ? EFFECTS["xess.repair"] : EFFECTS["xess.install"],
                job?.state === "running" ? "Wait for the running task." : game ? `Quit ${game.name} first.` : null)}>
              {act.busy === "xess" ? "Working…" : `${offer.kind === "install" ? "Install XeSS fast mode" : offerLabel(offer)}${INFO}`}
            </ButtonItem>
          </WithDetails>
        ) : (
          <ButtonItem layout="below" disabled={busy || chk.loading}
            onClick={() => act.run("check", async () => { const r = await chk.reload(); return r && !r.ok ? r.error : null; })}
            description={explain(chk.data?.ok ? firstSentence(checkText(chk.data, o.xess.installed, o.xess.version)) : "Changes nothing.")}>
            {chk.loading ? "Checking…" : "Check for XeSS update"}
          </ButtonItem>
        )}
        <Problem what="XeSS" error={act.error} />
      </PanelSectionRow>
    </>
  );
};

const noop = () => undefined;
let pinnedGame: string | null = null;      // the game whose errors "This game" may still show pinned
const GPU_HELD = /^(pl\d|power|vr_tdc)$/;

export const QuickPanel: FC = () => {
  const ov = useResource<Overview>("overview", get_overview, { fresh: true });
  const job = useCurrentJob();
  const o = ov.data?.ok ? ov.data : null;
  useEffect(() => { if (ov.data?.ok) syncJob(ov.data.job); }, [ov.data]);
  // oxp3-tool status waits for oxp3-tool's lock, which a running job holds: read it once the job has ended
  const st = useResource<StatusRes>("status", oxp3_status, { skip: !oxp3Usable(o?.oxp3) || job?.state === "running" });
  const app = useRunningApp();
  const status = st.data?.ok ? st.data.status : null;
  // what a closed group still needs for its summary and alerts: read here once, passed down (DESIGN.md "Data")
  const visible = useQuickAccessVisible();
  const p = usePower(visible);
  const ex = useExtrasState();
  const lv = useLive(visible);
  const auto = useAutoState();
  const refused = useRefused();
  useEffect(() => { if (!visible) clearRecentFixes(); }, [visible]);
  // another game: the last one's pinned errors do not belong to it
  useEffect(() => {
    if (!app) return;
    if (pinnedGame !== null && pinnedGame !== app.appid) clearPinned("game");
    pinnedGame = app.appid;
  }, [app?.appid]);
  // the XeSS cache only (xess_state is read by the open group): "Update available" once it is known
  const xs = useResource<XessStateRes>("xess", xess_state, { skip: true });
  const chk = useResource<XessUpdateCheck>("manual:xess-check", xess_check_update, { skip: true });

  const s = p.state, info = p.info, x = ex.x;
  const pd = { info, state: s, error: p.error };
  const ed = s ? editedSlot(s, info) : null;
  const vals = s && ed ? editedValues(s, ed.stored) : null;
  const cpu = info?.hw.cpu ?? null;
  const ignored = listText((info?.conflicts ?? []).filter((c) => c.kind === "cpu" && c.ignored).map((c) => friendlyName(c.id, c.name))) || "another program";

  const autoOn = !!(auto.data?.ok && auto.data.on);
  const game = app ? auto.data?.games?.[app.appid] ?? null : null;
  const rolled = rolledBackRows(game);
  const gameAlert = app && autoOn ? alertOf([
    rolled.length > 0 && { label: "Undone after a quick exit", line: rollbackText(rolled[0], app.name) },
    !!game?.last_error && { label: "Automatic setup: did not work", line: firstSentence(game.last_error) },
  ]) : null;
  const pAlert = powerAlert(info, s, p.error, refusedLive(refused, info, !!s?.enabled));
  const cAlert = cpuAlert(info, s, x);
  const bAlert = batteryAlert(x);
  const fAlert = o ? fixesAlert(o, st.data) : null;
  // any CPU: "CPU now" is there whenever power control is on
  const showCpu = !!s && ((s.enabled && !!cpu) || !!x?.scx.shown);
  const showBattery = !!x && (x.fan.available || x.charge.available);
  const fixes = fixCounts(st.data);
  const fixOffer = o ? oxp3Offer(o.oxp3) : null;
  const xUpdate = !!o && xessOffer(o.xess.installed, o.xess.version, xs.data?.xess ?? null, chk.data).kind === "update";

  return (
    <>
      <StatusSection o={o} err={ov.data && !ov.data.ok ? ov.data.error : null} st={status} />
      <Group id="live" title="Live" summary={liveSummary(lv.live, lv.error)}>
        <LiveRows live={lv.live} error={lv.error} />
      </Group>
      {app && (
        <Group id="game" title="This game" alert={gameAlert}
          summary={gameSummary(app.name, autoOn ? game?.mode ?? "auto" : null, !!s?.enabled && !!info?.profiles[app.appid])}
          alerts={gameAlert && <PanelSectionRow><AutoSetupRows app={app} running only="alerts" onWritten={noop} /></PanelSectionRow>}>
          <PanelSectionRow><AutoSetupSwitch /></PanelSectionRow>
          <PanelSectionRow><Note label={app.name} details={{ title: app.name, body: "Saved in the game's Steam launch options. Changes apply the next time you start it." }}>XeSS settings for this game</Note></PanelSectionRow>
          {s?.enabled && info?.options.per_game && <GameProfileToggle app={app} info={info} />}
          <GameControls app={app} quick running />
        </Group>
      )}
      <Group id="power" title="Power" alert={pAlert} alerts={pAlert && <PowerAlerts {...pd} />}
        summary={powerSummary(s, vals, { yieldedTo: s?.enabled && s.yielded?.length ? ignored : null,
          gpuHeld: !!s?.enabled && (s.now.gpu?.reasons ?? []).some((r) => GPU_HELD.test(r)) })}>
        <PowerBody {...pd} />
      </Group>
      {showCpu && (
        <Group id="cpu" title="CPU" alert={cAlert} alerts={cAlert && <CpuAlerts {...pd} x={x} />}
          summary={cpuSummary(s, info, vals, ed?.stored.scx_mode, x)}>
          <CpuBody {...pd} x={x} />
        </Group>
      )}
      {showBattery && (
        <Group id="battery" title="Fan & battery" alert={bAlert} alerts={bAlert && <BatteryBody {...pd} x={x} alerts />}
          summary={batterySummary(x, ed?.stored.fan_mode)}>
          <BatteryBody {...pd} x={x} />
        </Group>
      )}
      {o && (
        <Group id="xess" title="XeSS" summary={xessSummary(o.xess, xUpdate)}>
          <XessSection o={o} />
        </Group>
      )}
      {o && (
        <Group id="fixes" title="Device fixes" alert={fAlert} alerts={fAlert && <Oxp3Section o={o} st={st.data} loading={st.loading} only="alerts" />}
          summary={fixesSummary({ installed: o.oxp3.installed, usable: oxp3Usable(o.oxp3), update: !!fixOffer?.update,
            applied: status ? fixes.applied : null, recommended: fixes.recommended.length, attention: fixes.attention.length })}>
          <Oxp3Section o={o} st={st.data} loading={st.loading} />
        </Group>
      )}
      <PanelSection>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => openPage(app ? "games" : "fixes")}
            description={explain("Profiles, fixes, buttons, XeSS and more.")}>All settings</ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
};
