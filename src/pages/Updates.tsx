// Versions and updates of oxp3-tool and xess-xmx-linux, the diagnose archive, and the last tasks with their logs.
import { ButtonItem, Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { FC, useState } from "react";

import { blockedBy, installOxp3, installXess, started, useAction } from "../actions";
import { get_overview, job_list, job_status, oxp3_diagnose, oxp3_update_check, xess_check_update, xess_state } from "../backend";
import type { DetailsSpec } from "../components/confirm";
import { Code, explain, INFO, Note, Problem, Status, WithDetails } from "../components/Hint";
import { JobView, TaskSection } from "../components/JobView";
import { useCurrentJob, useResource } from "../store";
import { firstSentence, fitsOneLine } from "../text";
import type { Job, JobListRes, Overview, Oxp3UpdateCheck, XessStateRes, XessUpdateCheck } from "../types";
import { when } from "../util";
import { checkText, offerLabel, repairText, xessOffer } from "../xessoffer";
import { oxp3Offer, oxp3Usable } from "./Quick";

const JobRow: FC<{ j: Job }> = ({ j }) => {
  const [log, setLog] = useState<string[] | null>(null);   // null: hidden
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (log) { setLog(null); return; }
    // job_list may send short logs: the job's own answer has all of it
    setBusy(true);
    const r = await job_status(j.id);
    setBusy(false);
    setErr(r.ok ? null : r.error);
    setLog((r.ok && r.job ? r.job.log : j.log) ?? []);
  };
  return (
    <PanelSectionRow>
      <Status ok={j.state === "running" ? null : j.state === "done"} label={`${j.title}: ${j.state}`}
        detail={`${when(j.started)}${j.ended ? ` to ${when(j.ended)}` : ""}${j.error ? ` · ${firstSentence(j.error, 60)}` : ""}`}
        details={j.error && !fitsOneLine(j.error, 60) ? { title: j.title, body: j.error } : null} />
      <ButtonItem layout="below" onClick={toggle} disabled={busy}>
        {busy ? "Reading…" : log ? "Hide log" : "Show log"}
      </ButtonItem>
      {log && <Field focusable bottomSeparator="none" description={<Code>{log.length ? log.join("\n") : "(no lines)"}</Code>} />}
      <Problem what="Log" error={err} />
    </PanelSectionRow>
  );
};

export const UpdatesTab: FC = () => {
  const ov = useResource<Overview>("overview", get_overview, { fresh: true });
  const xs = useResource<XessStateRes>("xess", xess_state);
  const oc = useResource<Oxp3UpdateCheck>("manual:oxp3-check", oxp3_update_check, { skip: true });
  const xc = useResource<XessUpdateCheck>("manual:xess-check", xess_check_update, { skip: true });
  const jl = useResource<JobListRes>("jobs", job_list, { fresh: true });
  const job = useCurrentJob();
  const running = job?.state === "running";
  const oxp = useAction();
  const xes = useAction();
  const diag = useAction();
  const o = ov.data?.ok ? ov.data : null;
  const i = o?.oxp3;
  const x = xs.data?.ok ? xs.data.xess : null;

  // a usable oxp3-tool updates only when the check found something; a missing or too old one always gets the offer
  const check = oc.data?.ok ? oc.data : null;
  const offline = oxp3Offer(i);
  const offer = check?.update ? { source: check.update, version: check.update === "online" ? check.online : check.bundled, update: !!i?.installed }
    : offline && (!oxp3Usable(i) || !check) ? offline : null;
  // without xess_state the overview's summary says what is installed (FE-4); only a newer tag is an update (FE-1)
  const xInstalled = x ? x.installed : !!o?.xess.installed;
  const xVersion = x ? x.version : o?.xess.version ?? null;
  const xOffer = xessOffer(xInstalled, xVersion, x, xc.data);

  const diagD: DetailsSpec = {
    title: "Save a problem report",
    body: `An archive in ${o?.home ?? "your home folder"} with the device's state, this and the previous boot's system logs, and the controller and display logs. Serial numbers and network addresses are replaced; look through it before posting it. Changes nothing.`,
    lines: ["oxp3-tool diagnose", "~/oxp3-diagnose-<time>.tar.gz"],
  };
  return (
    <>
      <TaskSection />
      <PanelSection title="Fixes tool">
        <PanelSectionRow>
          {!o && <Problem what="Overview" error={ov.data && !ov.data.ok ? ov.data.error : null} />}
          {i && (
            <Status ok={oxp3Usable(i)} label={i.installed ? `Fixes tool ${i.version ?? "?"}` : "Fixes tool not installed"}
              detail={!i.installed ? "Needed for controller, sleep and screen fixes" : !oxp3Usable(i) ? "Too old: update it" : offer ? "Update available" : check ? "Up to date" : undefined}
              details={{ title: "Fixes tool (oxp3-tool)", body: `OXP3 Deck needs ${i.min_version} or newer.`,
                lines: [`path: ${i.path ?? "/usr/local/bin/oxp3-tool"}`, `in this plugin: ${i.bundled_version ?? "none"}`,
                  ...(i.installed && !i.json_ok ? ["its --json output does not work"] : []),
                  ...(check ? [`GitHub: ${check.online ?? "?"}${check.online_commit ? ` (${check.online_commit.slice(0, 7)})` : ""}`] : [])] }} />
          )}
          <ButtonItem layout="below" disabled={oc.loading || running}
            onClick={() => oxp.run("check", async () => { const r = await oc.reload(); return r && !r.ok ? r.error : null; })}
            description={explain("Changes nothing.")}>
            {oc.loading ? "Checking…" : "Check for an update"}
          </ButtonItem>
          {offer && (
            <ButtonItem layout="below" disabled={running || !!oxp.busy}
              onClick={() => oxp.run("install", async () => blockedBy() ?? installOxp3(offer.source, offer.version, offer.update))}
              description={explain("Takes a few seconds.")}>
              {oxp.busy === "install" ? "Working…" : `${offer.update ? "Update" : "Install"} fixes tool${offer.version ? ` ${offer.version}` : ""}`}
            </ButtonItem>
          )}
          <Problem what="oxp3-tool" error={oxp.error} />
        </PanelSectionRow>
        {oxp.job && <JobView job={oxp.job} lines={6} />}
      </PanelSection>
      <PanelSection title="XeSS fast mode">
        <PanelSectionRow>
          <Status ok={x ? x.installed : null} label={x?.installed ? `XeSS fast mode ${x.version ?? "?"}` : x ? "XeSS fast mode not installed" : "XeSS fast mode: …"}
            detail={xc.data?.ok ? firstSentence(checkText(xc.data, xInstalled, xVersion)) : undefined}
            details={x?.package_dir ? { title: "XeSS fast mode (xess-xmx-linux)", body: xc.data?.ok ? `${checkText(xc.data, xInstalled, xVersion)} (checked ${when(xc.data.checked_at)}).${xc.data.note ? ` ${xc.data.note}` : ""}` : "Installed.", lines: [x.package_dir] } : null} />
          <ButtonItem layout="below" disabled={xc.loading || running}
            onClick={() => xes.run("check", async () => { const r = await xc.reload(); return r && !r.ok ? r.error : null; })}
            description={explain("Changes nothing.")}>
            {xc.loading ? "Checking…" : "Check for an update"}
          </ButtonItem>
          {xOffer.kind && (x || o) && (
            <WithDetails details={{ title: offerLabel(xOffer), body: xOffer.kind === "update" ? `Updates ${xVersion ?? ""} to ${xOffer.latest}. Then log out and back in; asks first.`
              : xOffer.kind === "repair" ? `${repairText(xOffer)} Asks first.` : "Installs the newest release. Then log out and back in; asks first." }}>
              <ButtonItem layout="below" disabled={running || !!xes.busy}
                onClick={() => xes.run("install", async () => blockedBy() ?? installXess(xOffer, x, o?.user ?? null))}
                description={explain(xOffer.kind === "repair" ? "Runs the installer again." : "Log out and back in afterwards.")}>
                {xes.busy === "install" ? "Working…" : `${offerLabel(xOffer)}${INFO}`}
              </ButtonItem>
            </WithDetails>
          )}
          <Problem what="xess-xmx-linux" error={xes.error} />
        </PanelSectionRow>
        {xes.job && <JobView job={xes.job} lines={6} />}
      </PanelSection>
      <PanelSection title="Report a problem">
        <PanelSectionRow>
          <WithDetails details={diagD}>
            <ButtonItem layout="below" disabled={running || !!diag.busy || !oxp3Usable(i)}
              onClick={() => diag.run("diagnose", async () => blockedBy() ?? started(await oxp3_diagnose()))}
              description={explain("Saved to your home folder. Takes up to a minute.")}>
              {diag.busy ? "Starting…" : `Save a problem report${INFO}`}
            </ButtonItem>
          </WithDetails>
          <Problem what="Problem report" error={diag.error} />
          {o && <Note label="OXP3 Deck" details={{ title: "OXP3 Deck", body: `Version ${o.plugin_version}.`, lines: [`user: ${o.user}`, `home: ${o.home}`] }}>{`Version ${o.plugin_version}`}</Note>}
        </PanelSectionRow>
        {diag.job && <JobView job={diag.job} lines={6} />}
      </PanelSection>
      <PanelSection title="Last tasks">
        <PanelSectionRow>
          <Problem what="Tasks" error={jl.data && !jl.data.ok ? jl.data.error : null} />
          {jl.data?.ok && !jl.data.jobs?.length && <Note>No tasks yet.</Note>}
        </PanelSectionRow>
        {((jl.data?.ok && jl.data.jobs) || []).map((j) => <JobRow key={j.id} j={j} />)}
      </PanelSection>
    </>
  );
};
