// Automatic setup (DESIGN.md "Automatic setup (0.6)"): the switch "Set up games automatically", each game's rows
// (Automatic / Manual, what was set up and why, Undo, a rollback after a quick exit, the Proton note, the offers), the
// pass after a game quits, when its controls open and in a library scan, and the session events the backend's crash
// rollback needs. The rules and the pass are autosetup.ts's; this file wires them to Steam and the backend. Launch
// options and the Proton are written here only, never while the game runs (checked right before each write).
import { ButtonItem, DropdownItem, ToggleField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";

import { useAction } from "../actions";
import {
  auto_enable, auto_mode, auto_opti_install, auto_pending, auto_plan, auto_record, auto_retry, auto_session, auto_state, auto_undo,
  get_overview, get_setting, job_status,
} from "../backend";
import {
  acceptOffer, changeRow, ConfirmText, confirmEnable, fit, handSet, liveChanges, makeQueue, modeLine, offerConfirm, PassCause,
  launchStep, PassDeps, PassResult, plannedLabels, protonLine, rollbackText, runPass, summaryLine, switchLine, undoChange, undoConfirm,
} from "../autosetup";
import { appliedText } from "../autolaunch";
import { EFFECTS } from "../effects";
import { LOG_KEY as OPTI_LOG, readLog as readOptiLog } from "../opti";
import {
  compatTools, getCompat, getLaunchOptions, installedSteamApps, isRunning, isSteamApp, RunningApp, runningApp, runningApps,
  setCompatTool, setLaunchOptions, watchLifetime, watchRunningApp,
} from "../steam";
import { autoOnFor, markManual, noteGame, planKey, STATE_KEY, stateNow, useAutoState } from "../autostate";
import { invalidate, noteJob, peek, put, useCurrentJob, useResource } from "../store";
import type { AutoApplied, AutoChange, AutoFacts, AutoGame, AutoMode, AutoOffer, AutoPlanRes, AutoStateRes, Job, Overview } from "../types";
import { toast, when } from "../util";
import { loadLog, LegacyAutoRows, useAutoSettings } from "./AutoLaunch";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { explainWhen, label, Note, Problem, Status, WithDetails } from "./Hint";
import { JobView } from "./JobView";
import { optiApplyPending, resetOptiInflight, syncOptiLaunch } from "./OptiControls";

// ---- state ---------------------------------------------------------------------------------------------------------

export { autoOnFor, markManual, useAutoState };

const optiLogNow = async () => readOptiLog(await get_setting(OPTI_LOG));

/** What the backend's plan needs from Steam: the Proton now, the Protons Steam lists, the keys set by hand, running. */
const buildFacts = async (appid: string): Promise<AutoFacts> => {
  const [compat, tools, text, log, olog] = await Promise.all([getCompat(appid), compatTools(appid), getLaunchOptions(appid), loadLog(), optiLogNow()]);
  const live = liveChanges(peek<AutoStateRes>(STATE_KEY)?.games?.[appid]).filter((c) => c.kind === "launch" && c.launch).map((c) => c.launch!);
  return { compat, tools, hand: handSet(text, log[appid], olog[appid], appid, live), running: isRunning(appid) };
};

const loadPlan = async (appid: string): Promise<AutoPlanRes> => {
  const r = await auto_plan(appid, await buildFacts(appid));
  if (r.ok && r.plan) noteGame(r.plan.game);
  return r;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const JOB_POLL_MS = 2000;
export const JOB_MAX_MS = 20 * 60 * 1000;

/** Follow a backend job until it ends (job_status every 2 s, at most 20 min); null when it did not end in time. */
const waitJob = async (job: Job): Promise<Job | null> => {
  noteJob(job);
  const end = Date.now() + JOB_MAX_MS;
  let j = job;
  while (j.state === "running" && Date.now() < end) {
    await sleep(JOB_POLL_MS);
    const r = await job_status(j.id);
    if (r.ok && r.job) { j = r.job; noteJob(j); }
  }
  return j.state === "running" ? null : j;
};

const RUNNING = { ok: false, error: "The game runs; OXP3 Deck changes nothing while it runs." };

/** The pass's writes: never while that game runs, checked right before the write. */
const writeLaunch = async (appid: string, text: string) => {
  if (isRunning(appid)) return { ...RUNNING, text: null };
  return setLaunchOptions(appid, text);
};
const writeCompat = async (appid: string, name: string) => {
  if (isRunning(appid)) return { ...RUNNING, name: null };
  return setCompatTool(appid, name);
};

const DEPS: PassDeps = {
  facts: buildFacts,
  plan: async (appid, facts) => {
    const r = await auto_plan(appid, facts);
    if (r.ok && r.plan) noteGame(r.plan.game);
    return r;
  },
  isRunning,
  getLaunchOptions,
  setLaunchOptions: writeLaunch,
  setCompatTool: writeCompat,
  record: async (appid, change) => { const r = await auto_record(appid, change); noteGame(r.game); return r; },
  mode: async (appid, mode, why) => { const r = await auto_mode(appid, mode, why); noteGame(r.game); return r; },
  undo: async (appid, id, reason) => { const r = await auto_undo(appid, id, reason); noteGame(r.game); return r; },
  optiInstall: async (appid, accepted) => { const r = await auto_opti_install(appid, accepted); if (r.job) noteJob(r.job); return r; },
  waitJob,
  syncOpti: async (appid, want) => ({ error: (await syncOptiLaunch(appid, want)).error }),
  optiIn: async (appid) => !!(await optiLogNow())[appid]?.plan,
  legacyRec: async (appid) => (await loadLog())[appid],
  toast: (t) => toast(t),
};

// ---- the pass and its triggers -----------------------------------------------------------------------------------------

const queue = makeQueue();

/** One pass for one game (one at a time), only while the switch is on; refreshes the game's rows afterwards. */
export const autoPass = async (appid: string, name: string, cause: PassCause): Promise<PassResult | null> => {
  if (!isSteamApp(appid)) return null;
  const st = await stateNow();
  if (!st?.ok || !st.on) return null;
  const r = await queue.run(appid, () => runPass(DEPS, appid, name, cause));
  if (!r) return null;
  noteGame(r.game);
  if (r.changes.length || r.rolledBack || r.stopped === "touched") {
    invalidate(planKey(appid));
    invalidate(`game:${appid}`);
    invalidate(`opti-info:${appid}`);
  }
  return r;
};

// start and exit of each game for the crash rollback (the backend measures the run)
const sessions = new Map<string, Promise<unknown>>();
const exitTimers = new Set<ReturnType<typeof setTimeout>>();
/** The game's process ended: exitFlow after the session exit (and its rollback) is in, also for a game that never
 * became the main app; while Steam still lists it as running (Proton shutting down), again every 3 s, at most 5 times. */
export const EXIT_RETRIES = 5;
const afterExit = (appid: string, tries: number) => {
  const t = setTimeout(() => {
    exitTimers.delete(t);
    if (isRunning(appid)) {
      if (tries > 1) afterExit(appid, tries - 1);
      return;
    }
    const name = installedSteamApps().find((a) => a.appid === appid)?.name ?? "";
    exitFlow(appid, name).then(undefined, () => undefined);
  }, AUTO_AFTER_EXIT_MS);
  exitTimers.add(t);
};
const onLifetime = (appid: string, running: boolean) => {
  if (!isSteamApp(appid)) return;
  const st = peek<AutoStateRes>(STATE_KEY);
  if (st?.ok && !st.on) return;
  const p: Promise<unknown> = auto_session(appid, running ? "start" : "exit").then((r) => { noteGame(r.game); }, () => undefined);
  sessions.set(appid, p);
  void p.finally(() => { if (sessions.get(appid) === p) sessions.delete(appid); });
  if (!running) void p.then(() => afterExit(appid, EXIT_RETRIES));
};

/** After a game quits: OptiScaler's waiting launch options first, then the session exit (and its rollback), then the pass. */
export const exitFlow = async (appid: string, name: string): Promise<void> => {
  if (isRunning(appid)) return;
  try { await optiApplyPending(appid, name); } catch { /* its own row says it */ }
  try { await sessions.get(appid); } catch { /* the backend did not answer */ }
  if (isRunning(appid)) return;
  await autoPass(appid, name, "exit");
};

/** When the main app moves away from a game that then no longer runs: exitFlow 3 s later. */
export const AUTO_AFTER_EXIT_MS = 3000;
export const watchGameExits = (): (() => void) => {
  let prev: RunningApp | null = runningApp();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stop = watchRunningApp((now) => {
    const left = prev;
    prev = now;
    if (!left || left.appid === now?.appid || !isSteamApp(left.appid)) return;
    const t = setTimeout(() => {
      timers.delete(t);
      if (!isRunning(left.appid)) exitFlow(left.appid, left.name).then(undefined, () => undefined);
    }, AUTO_AFTER_EXIT_MS);
    timers.add(t);
  });
  return () => { stop(); timers.forEach((t) => clearTimeout(t)); timers.clear(); resetOptiInflight(); };
};

export const SCAN_FIRST_MS = 20 * 1000;
export const SCAN_EVERY_MS = 10 * 60 * 1000;
export const SCAN_MAX = 8;
let scanning = false;

/** The library scan: games the backend has not seen (or under an older plan, or with a rollback due), at most 8. */
export const scanLibrary = async (): Promise<void> => {
  if (scanning || runningApp()) return;
  scanning = true;
  try {
    const st = await auto_state();
    if (st.ok) put(STATE_KEY, st);
    if (!st.ok || !st.on) return;
    const apps = installedSteamApps();
    const names = new Map(apps.map((a) => [a.appid, a.name]));
    const r = await auto_pending(apps.map((a) => a.appid).slice(0, 2000));
    if (!r.ok) return;
    for (const id of (r.appids ?? []).slice(0, SCAN_MAX)) {
      if (runningApp()) break;
      if (!isSteamApp(id) || isRunning(id)) continue;
      await autoPass(id, names.get(id) ?? "", "scan");
    }
  } finally {
    scanning = false;
  }
};

/** For index.tsx: the exit watch, the session events, the starts at load and the library scan. */
export const watchAutoSetup = (): (() => void) => {
  const stopExits = watchGameExits();
  const stopLife = watchLifetime((appid, running) => onLifetime(appid, running));
  // a game already running at load (a plugin reload mid-game): its start, unless the backend has one
  void auto_state().then((st) => {
    if (st.ok) put(STATE_KEY, st);
    if (!st.ok || !st.on) return;
    for (const id of runningApps()) if (!st.games?.[id]?.session?.started_at) onLifetime(id, true);
  }, () => undefined);
  const first = setTimeout(() => { void scanLibrary(); }, SCAN_FIRST_MS);
  const every = setInterval(() => { void scanLibrary(); }, SCAN_EVERY_MS);
  return () => {
    stopExits();
    stopLife();
    clearTimeout(first);
    clearInterval(every);
    queue.clear();
    sessions.clear();
    exitTimers.forEach((t) => clearTimeout(t));
    exitTimers.clear();
  };
};

// ---- the switch ------------------------------------------------------------------------------------------------------

const ask = (t: ConfirmText) =>
  confirm({ title: t.title, text: paragraphs(t.text), ok: t.ok, effect: t.effect, lines: t.lines, linesTitle: t.linesTitle, destructive: t.destructive });

/** "Set up games automatically" (Games tab top, XeSS tab, the quick panel's "This game"). */
export const AutoSetupSwitch: FC = () => {
  const st = useAutoState();
  const old = useAutoSettings();
  const ov = useResource<Overview>("overview", get_overview);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);
  const on = !!(st.data?.ok && st.data.on);
  const user = ov.data?.ok ? ov.data.user : null;
  const t = confirmEnable(user);
  const d: DetailsSpec = { title: "Set up games automatically", body: paragraphs(t.text), lines: t.lines, linesTitle: t.linesTitle };

  const toggle = async (want: boolean) => {
    setErr(null);
    if (want) {
      const ok = await confirm({ title: t.title, text: paragraphs(t.text), ok: t.ok, effect: EFFECTS["auto.global"], lines: t.lines, linesTitle: t.linesTitle });
      if (!ok) { setRev((n) => n + 1); return; }
    }
    setBusy(true);
    try {
      const r = await auto_enable(want, want);
      if (!r.ok) { setErr(r.error); setRev((n) => n + 1); return; }
      put(STATE_KEY, r);
      invalidate("auto:plan:");
      if (want) setTimeout(() => { void scanLibrary(); }, 1000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <WithDetails details={d}>
        <ToggleField key={`auto-${rev}`} label={label("Set up games automatically", d)} checked={on} disabled={busy || !st.data?.ok}
          onChange={toggle} bottomSeparator="none"
          description={explainWhen(switchLine(on, !!old.data?.on), EFFECTS["auto.global"],
            st.data && !st.data.ok ? "The backend did not answer." : null)} />
      </WithDetails>
      <Problem what="Automatic setup" error={err ?? (st.data && !st.data.ok ? st.data.error : null)} />
    </>
  );
};

// ---- one game --------------------------------------------------------------------------------------------------------

const MODES: { data: AutoMode; label: string }[] = [{ data: "auto", label: "Automatic" }, { data: "manual", label: "Manual" }];

/** Rolled-back changes still to show: newer than any later change of the same kind. */
const rolledBackRows = (g: AutoGame | null | undefined): AutoChange[] => {
  const all = g?.changes ?? [];
  return all.filter((c) => c.state === "rolled_back" && !all.some((o) => o.kind === c.kind && o.at > c.at));
};

const changeDetails = (c: AutoChange): DetailsSpec => {
  const before = c.kind === "proton" && c.proton ? `${c.proton.from || "Steam's default"} → ${c.proton.to}`
    : c.kind === "launch" && c.launch ? appliedText(c.launch) : c.kind === "opti" && c.opti ? `OptiScaler ${c.opti.build}` : null;
  return {
    title: changeRow(c).label,
    body: paragraphs([c.why, `Set up ${when(c.at)}${c.accepted ? " (you tapped Use it)" : ""}. Applies from the next start.`,
      c.kept ? "Kept after Try again: a quick exit no longer undoes it (three in a row still do)." : null,
      "Undo puts back what was there before and makes this game Manual."]),
    lines: before ? [before] : undefined, linesTitle: c.kind === "launch" ? "Launch options:" : "Technical:",
  };
};

/**
 * A game's automatic setup rows (GameControls, above the XeSS options), plus an old 0.4 record's "Added: …" row.
 * `onWritten(text)`: the launch options changed here (GameControls shows them).
 */
export const AutoSetupRows: FC<{ app: RunningApp; running: boolean; onWritten: (text: string | null) => void }> = ({ app, running, onWritten }) => {
  const appid = app.appid;
  const steam = isSteamApp(appid);
  const st = useAutoState();
  const on = !!(st.data?.ok && st.data.on);
  const planRes = useResource<AutoPlanRes>(on && steam ? planKey(appid) : null, () => loadPlan(appid), { fresh: true });
  const plan = planRes.data?.ok ? planRes.data.plan : null;
  const game: AutoGame | null = st.data?.games?.[appid] ?? plan?.game ?? null;
  const act = useAction();
  const cur = useCurrentJob();
  const [rev, setRev] = useState(0);
  const [passErr, setPassErr] = useState<string | null>(null);
  const tried = useRef<string | null>(null);
  // what the launch-option step would change now (for "Will be set up when you quit" and Details)
  const [launchNow, setLaunchNow] = useState<AutoApplied | null>(null);
  useEffect(() => {
    setLaunchNow(null);
    if (!plan?.launch) return;
    let live = true;
    void Promise.all([getLaunchOptions(appid), optiLogNow(), loadLog()]).then(([text, olog, log]) => {
      if (live && text !== null) setLaunchNow(launchStep(appid, text, plan, !!olog[appid]?.plan, log[appid]).applied);
    }, () => undefined);
    return () => { live = false; };
  }, [appid, plan, running]);

  const afterPass = (r: PassResult | null) => {
    if (!r) return;
    setPassErr(r.error);
    if (r.text !== null) onWritten(r.text);
    else if (r.changes.length || r.rolledBack) getLaunchOptions(appid).then(onWritten);
  };

  // opening the controls of a game that does not run: a pass, once per mount
  useEffect(() => {
    if (!on || running || !steam || tried.current === appid) return;
    tried.current = appid;
    autoPass(appid, app.name, "open").then(afterPass, () => undefined);
  }, [appid, on, running]);

  const pickMode = (m: AutoMode) => act.run("mode", async () => {
    const r = await auto_mode(appid, m, null);            // no why: the user's own pick (mode_by "user")
    if (!r.ok) { setRev((n) => n + 1); return r.error || "refused"; }
    noteGame(r.game);
    await planRes.reload();
    if (m === "auto" && !isRunning(appid)) afterPass(await autoPass(appid, app.name, "open"));
    return null;
  });

  const undoOne = (c: AutoChange) => act.run(`undo-${c.id}`, async () => {
    if (!(await ask(undoConfirm(c, app.name)))) return null;
    const r = await undoChange(DEPS, appid, c, "user", app.name);
    noteGame(r.game);
    if (r.text !== null) onWritten(r.text);
    if (!r.ok) return r.error;
    markManual(appid, "You tapped Undo.");
    invalidate(`game:${appid}`);
    invalidate(`opti-info:${appid}`);
    await planRes.reload();
    return null;
  });

  const retry = (c: AutoChange) => act.run(`retry-${c.id}`, async () => {
    if (isRunning(appid)) return `Quit ${app.name} first.`;
    const r = await auto_retry(appid, c.id);
    if (!r.ok) return r.error || "refused";
    noteGame(r.game);
    afterPass(await autoPass(appid, app.name, "open"));
    await planRes.reload();
    return null;
  });

  const takeOffer = (o: AutoOffer) => act.run(`offer-${o.id}`, async () => {
    if (isRunning(appid)) return `Quit ${app.name} first.`;
    if (!(await ask(offerConfirm(o, app.name)))) return null;
    const r = await acceptOffer(DEPS, appid, app.name, o, await buildFacts(appid));
    if (r.text !== null) onWritten(r.text);
    invalidate(`game:${appid}`);
    invalidate(`opti-info:${appid}`);
    await planRes.reload();
    return r.ok ? null : r.error;
  });

  if (!steam) return null;
  const legacy = <LegacyAutoRows app={app} running={running} onWritten={onWritten} onUndone={() => markManual(appid, "You tapped Undo.")} />;
  const quit = running ? `Quit ${app.name} first.` : null;
  const live = liveChanges(game);
  const changeRows = live.map((c) => {
    const row = changeRow(c);
    const d = changeDetails(c);
    return (
      <div key={c.id}>
        <Status ok={null} label={row.label} detail={row.line} details={d} />
        <WithDetails details={{ title: `Undo: ${row.label}`, body: paragraphs(undoConfirm(c, app.name).text) }}>
          <ButtonItem layout="below" disabled={!!act.busy || running} onClick={() => undoOne(c)}
            description={explainWhen("Puts back what was there before.", EFFECTS["game.auto_undo"], quit)}>
            {act.busy === `undo-${c.id}` ? "Working…" : "Undo"}
          </ButtonItem>
        </WithDetails>
      </div>
    );
  });
  const removeJob = cur && cur.kind === "opti-remove" && act.busy?.startsWith("undo-") ? cur : null;
  if (!on) {
    // switch off: no passes; past changes keep their rows and Undo
    return <>{legacy}{changeRows}{removeJob && <JobView job={removeJob} />}<Problem what="Automatic setup" error={act.error} /></>;
  }

  const skipped = plan?.class === "skipped";
  const mode = plan?.mode ?? game?.mode ?? "auto";
  const modeD: DetailsSpec = {
    title: "Set up this game",
    body: paragraphs([
      plan ? (plan.class === "known" ? "OXP3 Deck knows this game: it applies its best known setup."
        : plan.class === "unknown" ? "OXP3 Deck doesn't know this game: it only applies what can only help (XeSS on the XMX cores, the Proton move); the rest is offered."
        : plan.skip_why ?? "OXP3 Deck changes nothing by itself for this game.") : null,
      plan && plannedLabels(plan, launchNow).length ? `Planned: ${plannedLabels(plan, launchNow).join(", ")}.` : "Nothing more to set up now.",
      plan?.offers.length ? `Offered: ${plan.offers.map((o) => o.label).join(", ")}.` : null,
      "Automatic: OXP3 Deck sets this game up by itself while it is not running. Manual: it changes nothing. Any change you make here switches it to Manual.",
      "If the game closes within a minute after a change, that change is undone before its next start; three quick exits in a row undo the newest change.",
    ]),
  };
  const summary = summaryLine(game);
  const summaryD: DetailsSpec = {
    title: "Set up automatically",
    body: paragraphs(live.map((c) => `${changeRow(c).label}: ${c.why} (${when(c.at)}).`).concat(["Applies from the next start."])),
  };
  // launch options not read yet: only what else is planned
  const waiting = running && !skipped && mode === "auto" ? plannedLabels(plan, launchNow ?? { set: {}, dropped: {}, args: [] }) : [];
  const note = plan?.proton_note ? protonLine(plan.proton_note) : null;
  const lastRun = game?.session?.last_run_s;

  return (
    <>
      {skipped ? (
        <Status ok={null} label="Set up this game" detail={modeLine(plan)} details={modeD} />
      ) : (
        <WithDetails details={modeD}>
          <DropdownItem key={`auto-mode-${appid}-${mode}-${rev}`} label={label("Set up this game", modeD)} menuLabel="Set up this game"
            layout="below" childrenContainerWidth="max" bottomSeparator="none" disabled={!!act.busy || !plan}
            rgOptions={MODES} selectedOption={mode} onChange={(o) => pickMode(o.data as AutoMode)}
            description={explainWhen(modeLine(plan ?? (game ? { ...game } : null)), EFFECTS["game.auto_mode"])} />
        </WithDetails>
      )}
      {!!summary && <Status ok label="Set up automatically" detail={summary} details={summaryD} />}
      {changeRows}
      {removeJob && <JobView job={removeJob} />}
      {waiting.length > 0 && (
        <Status ok={null} label={fit(`Will be set up when you quit ${app.name}`)} detail={fit(waiting.join(", "))} />
      )}
      {rolledBackRows(game).map((c) => (
        <div key={`rb-${c.id}`}>
          <Status ok={false} red label="Undone after a quick exit" detail={rollbackText(c, app.name)} details={{
            title: "Undone after a quick exit",
            body: paragraphs([game?.notice, lastRun !== null && lastRun !== undefined ? `The last run lasted ${Math.round(lastRun)} s.` : null,
              "A run shorter than 60 s right after an automatic change undoes that change before the next start; three quick exits in a row undo the newest change. Quitting quickly yourself counts too.",
              "Try again applies it once more; a single quick exit then no longer undoes it."]),
          }} />
          <ButtonItem layout="below" disabled={!!act.busy || running} onClick={() => retry(c)}
            description={explainWhen("Applies it again; it won't be undone for a quick exit again.", EFFECTS["game.auto_retry"], quit)}>
            {act.busy === `retry-${c.id}` ? "Working…" : "Try again"}
          </ButtonItem>
        </div>
      ))}
      {note && <Status ok={false} label={note.label} detail={note.line} details={{ title: note.label, body: note.detail }} />}
      {plan?.needs_xess && <Note label="Automatic setup">Install XeSS fast mode first (XeSS tab).</Note>}
      {!skipped && (plan?.offers ?? []).map((o) => (
        <WithDetails key={`offer-${o.id}`} details={{ title: `Also possible: ${o.label}`, body: o.why || o.line }}>
          <ButtonItem layout="below" disabled={!!act.busy || running} onClick={() => takeOffer(o)} label={fit(`Also possible: ${o.label}`, 60)}
            description={explainWhen(fit(o.line), EFFECTS["game.auto_offer"], quit)}>
            {act.busy === `offer-${o.id}` ? "Working…" : "Use it"}
          </ButtonItem>
        </WithDetails>
      ))}
      {legacy}
      <Problem what="Automatic setup" error={act.error ?? passErr ?? game?.last_error ?? (planRes.data && !planRes.data.ok ? planRes.data.error : null)} />
    </>
  );
};
