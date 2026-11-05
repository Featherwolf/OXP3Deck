// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// Based on ClawDeck's QuickPanel (src/pages.tsx): the Quick Access panel.
// Short: the state of the device, what waits for the user, and the running game's XeSS options. Everything else is
// on the full page ("More").
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { FC, useEffect } from "react";

import { applyFixes, blockedBy, fixesEffect, installOxp3, installXess, useAction } from "../actions";
import { get_overview, oxp3_status, xess_check_update, xess_state } from "../backend";
import { GameControls } from "../components/GameControls";
import { DetailsSpec, paragraphs } from "../components/confirm";
import { explain, explainWhen, INFO, Note, Problem, Status, WithDetails } from "../components/Hint";
import { EFFECTS } from "../effects";
import { JobView } from "../components/JobView";
import { PowerSection } from "../components/PowerControls";
import { RebootRow } from "../components/Reboot";
import { openPage } from "../nav";
import { useRunningApp } from "../steam";
import { syncJob, useCurrentJob, useResource } from "../store";
import { firstSentence, fitsOneLine } from "../text";
import type { Overview, Oxp3Install, Oxp3Status, StatusRes, XessStateRes, XessSummary, XessUpdateCheck } from "../types";
import { atLeast, cmpVersion, listText, platformName } from "../util";
import { checkText, offerLabel, repairText, xessOffer } from "../xessoffer";

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

/** The XeSS status row: label, one line up front, and the longer text for its Details. */
export const xessLine = (x: XessSummary | null | undefined): { ok: boolean | null; label: string; detail: string; more: string } => {
  const what = "Fast mode runs XeSS upscaling and frame generation on the GPU's XMX cores (xess-xmx-linux) instead of the slower DP4a path.";
  if (!x) return { ok: null, label: "XeSS fast mode: …", detail: "", more: what };
  if (!x.installed) return { ok: false, label: "XeSS fast mode: Off", detail: "Not installed. Games use the slower mode.", more: what };
  const v = x.version ? ` (${x.version})` : "";
  if (x.relogin_needed) return { ok: null, label: "XeSS fast mode: Log out needed", detail: "Log out and back in to turn it on.", more: `Installed${v}, but Steam still runs with the old driver setting: log out and back in (or reboot). ${what}` };
  if (x.status === "failed") return { ok: false, label: "XeSS fast mode: Off", detail: "The fast driver failed its check.", more: `${x.line ?? "The session check fell back to the system driver: games use DP4a."}${v} ${what}` };
  if (x.status === "unknown") return { ok: null, label: "XeSS fast mode: Not checked", detail: "Checked at the next log-in.", more: `Installed${v}. The driver check runs at the next log-in. ${what}` };
  return x.live ? { ok: true, label: "XeSS fast mode: On", detail: `Installed${v}`, more: `${x.line ?? "The fast driver is the session's graphics driver."} ${what}` }
    : { ok: null, label: "XeSS fast mode: Log out needed", detail: "Log out and back in to turn it on.", more: `Installed${v}; the session does not use the fast driver yet. ${what}` };
};

const StatusSection: FC<{ o: Overview | null; err: string | null; st: Oxp3Status | null }> = ({ o, err, st }) => {
  const os = st ? `${st.os.name ?? platformName(st.os.platform)}${st.os.kernel ? `, kernel ${st.os.kernel}` : ""}` : platformName(o?.platform);
  return (
    <PanelSection title="Status">
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

const Oxp3Section: FC<{ o: Overview; st: StatusRes | undefined; loading: boolean }> = ({ o, st, loading }) => {
  const act = useAction();
  const inst = useAction();     // its own, so its error shows under it also while oxp3-tool is missing (FE-2)
  const job = useCurrentJob();
  const running = job?.state === "running";
  const i = o.oxp3;
  const offer = oxp3Offer(i);
  const usable = oxp3Usable(i);
  const status = st?.ok ? st.status : null;
  const recommended = (status?.fixes ?? []).filter((f) => f.state === "recommended");
  const attention = (status?.fixes ?? []).filter((f) => f.state === "damaged" || f.state === "incomplete");
  const applied = (status?.fixes ?? []).filter((f) => f.state === "applied").length;
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
    <PanelSection title="Device fixes">
      <PanelSectionRow>
        <Status ok={usable ? true : false}
          label={!i.installed ? "Fixes tool not installed" : usable ? "Device fixes" : "Fixes tool too old"}
          detail={!i.installed ? "Needed for controller, sleep and screen fixes"
            : !usable ? "Update it to use the fixes."
            : status ? `${applied} fix${applied === 1 ? "" : "es"} applied${status.can_change ? "" : " · this system is not supported"}` : loading ? "Reading…" : undefined}
          details={{ title: "Fixes tool (oxp3-tool)", body: `OXP3 Deck needs ${i.min_version} or newer.${status && !status.can_change ? " This system is not supported, so nothing can be changed." : ""}`,
            lines: [`installed: ${i.version ?? "none"}`, `path: ${i.path ?? "/usr/local/bin/oxp3-tool"}`] }} />
        {offer && (
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
          {recommended.length > 0 && (
            <Status ok={null} label={`Recommended fixes (${recommended.length})`} details={recD}
              detail={firstSentence(recommended.map((f) => f.title).join(", "))} />
          )}
          {recommended.length > 0 && status.can_change && (
            <WithDetails details={applyD}>
              <ButtonItem layout="below" disabled={!!act.busy || !!inst.busy || running}
                onClick={() => act.run("apply", async () => blockedBy() ?? applyFixes(recommended, {}, "Apply the recommended fixes"))}
                description={explainWhen("Shows what will change before anything happens.", fixesEffect(recommended), running ? "Wait for the running task." : null)}>
                {act.busy === "apply" ? "Reading the plan…" : `Apply recommended (${recommended.length})${INFO}`}
              </ButtonItem>
            </WithDetails>
          )}
          {recommended.length === 0 && attention.length === 0 && <Status ok label="Fixes up to date" />}
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
    </PanelSection>
  );
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
    <PanelSection title="XeSS">
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
    </PanelSection>
  );
};

export const QuickPanel: FC = () => {
  const ov = useResource<Overview>("overview", get_overview, { fresh: true });
  const job = useCurrentJob();
  const o = ov.data?.ok ? ov.data : null;
  useEffect(() => { if (ov.data?.ok) syncJob(ov.data.job); }, [ov.data]);
  // oxp3-tool status waits for oxp3-tool's lock, which a running job holds: read it once the job has ended
  const st = useResource<StatusRes>("status", oxp3_status, { skip: !oxp3Usable(o?.oxp3) || job?.state === "running" });
  const app = useRunningApp();
  const status = st.data?.ok ? st.data.status : null;
  return (
    <>
      <StatusSection o={o} err={ov.data && !ov.data.ok ? ov.data.error : null} st={status} />
      <PowerSection quick app={app} />
      {o && <Oxp3Section o={o} st={st.data} loading={st.loading} />}
      {o && <XessSection o={o} />}
      {app && (
        <PanelSection title="This game">
          <PanelSectionRow><Note label={app.name} details={{ title: app.name, body: "Saved in the game's Steam launch options. Changes apply the next time you start it." }}>XeSS settings for this game</Note></PanelSectionRow>
          <GameControls app={app} quick running />
        </PanelSection>
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
