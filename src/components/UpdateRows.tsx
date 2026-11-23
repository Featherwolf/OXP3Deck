// The daily update checks' rows (DESIGN.md "Daily update checks", ROADMAP T1-9 + C-5): the automatic answers put into
// the "manual:" caches, the one-tap notices (the bundled oxp3-tool: an install job; helpers to apply again; a new
// OXP3 Deck: its install URL copied) and the "Check for updates automatically" switch. Texts are updates.ts's.
import { ButtonItem, TextField, ToggleField } from "@decky/ui";
import { FC, useEffect, useState } from "react";

import { applyFixes, blockedBy, fixesEffect, installOxp3, useAction } from "../actions";
import { set_setting } from "../backend";
import { copyText } from "../clipboard";
import { EFFECTS } from "../effects";
import { afterJob, currentJob, filledAt, put, useCurrentJob } from "../store";
import type { Overview, Oxp3Status } from "../types";
import {
  autoDetails, autoLine, bundledNotice, CHECK_KEYS, helpersNotice, installedToast, Notice, oxp3Fill, pluginNotice,
  staleHelpers, xessFill,
} from "../updates";
import { toast, when } from "../util";
import { explain, explainWhen, INFO, label, Problem, Status, WithDetails } from "./Hint";

/** Put the backend's automatic answers into the update caches, so closed groups say "Update available". */
export const useAutoChecks = (o: Overview | null) => {
  const u = o?.updates;
  useEffect(() => {
    if (!o || !u) return;
    const oc = oxp3Fill(u, o.oxp3, filledAt(CHECK_KEYS.oxp3));
    if (oc) put(CHECK_KEYS.oxp3, oc, u.oxp3?.checked_at);
    const xc = xessFill(u, o.xess, filledAt(CHECK_KEYS.xess));
    if (xc) put(CHECK_KEYS.xess, xc, xc.checked_at);
  }, [u?.oxp3?.checked_at, u?.xess?.checked_at, o?.oxp3.version, o?.xess.version]);
};

const details = (n: Notice) => ({ title: n.title, body: n.body });

/** "oxp3-tool 0.4.4 bundled" with Install (asks first, then a job), and "Apply again (N)" for helpers it left old. */
export const BundledNotice: FC<{ o: Overview | null; st: Oxp3Status | null }> = ({ o, st }) => {
  const act = useAction();
  const job = useCurrentJob();
  const running = job?.state === "running";
  const n = bundledNotice(o?.oxp3);
  const stale = staleHelpers(st);
  const h = helpersNotice(stale);
  const install = async () => {
    const v = o?.oxp3.bundled_version ?? null;
    const err = blockedBy() ?? await installOxp3("bundled", v, true);
    const j = currentJob();
    if (!err && j?.kind === "oxp3-install" && j.state === "running") {
      afterJob(j.id, (end) => { if (end.state === "done") { const t = installedToast(v); toast(t.body, t.title); } });
    }
    return err;
  };
  if (!n && !h) return null;
  return (
    <>
      {n && (
        <WithDetails details={details(n)}>
          <ButtonItem layout="below" label={n.label} disabled={running || !!act.busy}
            onClick={() => act.run("install", install)}
            description={explainWhen(n.line, EFFECTS["oxp3.install"], running ? "Wait for the running task." : null)}>
            {act.busy === "install" ? "Working…" : `${n.button}${INFO}`}
          </ButtonItem>
        </WithDetails>
      )}
      {h && (
        <WithDetails details={details(h)}>
          <ButtonItem layout="below" disabled={running || !!act.busy}
            onClick={() => act.run("again", async () => blockedBy() ?? applyFixes(stale, {}, "Apply again after the update"))}
            description={explainWhen(h.line, fixesEffect(stale), running ? "Wait for the running task." : null)}>
            {act.busy === "again" ? "Reading the plan…" : `${h.button}${INFO}`}
          </ButtonItem>
        </WithDetails>
      )}
      <Problem what="oxp3-tool" error={act.busy ? null : act.error} onRetry={act.retry} />
    </>
  );
};

/** "OXP3 Deck 0.6.0 available" with Copy install URL; the URL in a field when no clipboard method works. */
export const PluginNotice: FC<{ o: Overview | null }> = ({ o }) => {
  const [manual, setManual] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = pluginNotice(o?.updates, o?.plugin_version);
  const url = o?.updates?.install_url ?? "";
  if (!n || !url) return null;
  const copy = async (e?: MouseEvent) => {
    setBusy(true);
    const how = await copyText(url, (e?.currentTarget ?? e?.target ?? null) as { ownerDocument?: unknown } | null);
    setBusy(false);
    if (how) { setManual(null); toast("Paste it in Decky: Developer → Install Plugin from URL.", "Copied"); }
    else setManual(url);
  };
  return (
    <>
      <WithDetails details={{ ...details(n), lines: [url] }}>
        <ButtonItem layout="below" label={n.label} disabled={busy} onClick={copy} description={explain(n.line)}>
          {busy ? "Copying…" : `${n.button}${INFO}`}
        </ButtonItem>
      </WithDetails>
      {manual !== null && (
        <TextField label="Install URL" value={manual} bShowCopyAction onChange={() => setManual(url)}
          description={explain("Couldn't copy. Select the link and copy it with Steam's keyboard.")} />
      )}
    </>
  );
};

/** "Check for updates automatically" (settings.json update_auto, default on). */
export const AutoCheckToggle: FC<{ o: Overview | null; onChanged: () => unknown }> = ({ o, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const u = o?.updates;
  if (!o) return null;
  const on = u ? u.on : true;
  const d = autoDetails(u, when);
  const toggle = async (want: boolean) => {
    setBusy(true);
    try {
      const r = await set_setting("update_auto", want);
      setErr(r.ok ? null : r.error);
      if (!r.ok) setRev((x) => x + 1);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <WithDetails details={d}>
        <ToggleField key={`upd-${rev}`} label={label("Check for updates automatically", d)} checked={on} disabled={busy || !u}
          onChange={toggle} bottomSeparator="none"
          description={explainWhen(autoLine(on), EFFECTS["updates.auto"], !u ? "The backend did not answer." : null)} />
      </WithDetails>
      {u?.checked_at ? <Status ok={null} label="Last automatic check" detail={when(u.checked_at)} /> : null}
      <Problem what="Automatic checks" error={err} />
    </>
  );
};
