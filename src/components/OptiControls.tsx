// OptiScaler for one game (DESIGN.md "OptiScaler (0.5)", "UI"): install, the choices, the in-game checklist, update
// and remove, and the launch options its plan needs. The backend puts OptiScaler into the game's folder (a job) and
// answers the plan; this file writes the plan into Steam's launch options, never while the game runs (then it waits
// for the game to quit, like the automatic launch options). The rules are opti.ts's.
import { ButtonItem, DropdownItem, ToggleField } from "@decky/ui";
import { FC, useEffect, useState } from "react";

import { blockedBy, started, useAction } from "../actions";
import { get_setting, opti_info, opti_install, opti_options, opti_remove, opti_set, opti_update, set_setting } from "../backend";
import { EFFECTS } from "../effects";
import {
  CHECKLIST_HELP, checklist, checklistLine, choiceLabels, confirmInstall, confirmRemove, DEFAULT_CHOICES, FGS, fitLog, INPUTS,
  LOG_KEY, OptiConfirm, OptiLog, OptiLogEntry, pendingEntry, planLines, readChoices, readLog, readyToast, statusLine,
  syncPlan, UPSCALERS, warningRows,
} from "../opti";
import { getLaunchOptions, isRunning, isSteamApp, RunningApp, setLaunchOptions } from "../steam";
import { afterJob, notePending, put, useCurrentJob, useResource } from "../store";
import type { GameInfo, Job, LaunchPlan, OptiChoices, OptiInfo, OptiInfoRes, OptiJobResult } from "../types";
import { toast, when } from "../util";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { Pending } from "./Effect";
import { explain, explainWhen, label, Note, Problem, Status, WithDetails } from "./Hint";
import { JobView } from "./JobView";

const loadLog = async (): Promise<OptiLog> => readLog(await get_setting(LOG_KEY));
export const useOptiLog = () => useResource<OptiLog>("ui:opti-log", loadLog);

const saveEntry = async (appid: string, e: OptiLogEntry | null): Promise<string | null> => {
  const log: OptiLog = { ...(await loadLog()) };
  if (e) log[appid] = e; else delete log[appid];
  const v = fitLog(log);
  const r = await set_setting(LOG_KEY, v);
  if (r.ok) put("ui:opti-log", v);
  return r.ok ? null : r.error;
};

export type OptiWrite = { text: string | null; error: string | null; waiting: boolean; changed: boolean };
const now = () => Math.floor(Date.now() / 1000);
let inflight = new Set<string>();

/**
 * Bring a game's launch options to OptiScaler's plan (`want`; null: OptiScaler was removed, so take out what it
 * added and put back what it took out). Never while the game runs: then the change is recorded as pending and
 * applied when the game has quit (optiApplyPending from the exit watch).
 */
export const syncOptiLaunch = async (appid: string, want: LaunchPlan | null): Promise<OptiWrite> => {
  const none: OptiWrite = { text: null, error: null, waiting: false, changed: false };
  if (!isSteamApp(appid)) return none;
  if (inflight.has(appid)) return { ...none, error: "OXP3 Deck is already changing this game's launch options." };
  inflight.add(appid);
  try {
    const rec = (await loadLog())[appid];
    if (isRunning(appid)) return { ...none, waiting: true, error: await saveEntry(appid, pendingEntry(rec, want, now())) };
    const text = await getLaunchOptions(appid);
    if (text === null) {
      await saveEntry(appid, pendingEntry(rec, want, now()));
      return { ...none, error: "Steam did not return the launch options, so OXP3 Deck did not change them: use Copy launch options." };
    }
    const s = syncPlan(text, rec, want, now());
    let out = text;
    if (s.text !== text) {
      // never while that game runs: checked right before the write
      if (isRunning(appid)) return { ...none, waiting: true, error: await saveEntry(appid, pendingEntry(rec, want, now())) };
      const r = await setLaunchOptions(appid, s.text);
      if (!r.ok) {
        await saveEntry(appid, pendingEntry(rec, want, now()));
        return { ...none, text: r.text, error: r.error };
      }
      out = r.text ?? s.text;
    }
    return { text: out, error: await saveEntry(appid, s.entry), waiting: false, changed: s.text !== text };
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : String(e) };
  } finally {
    inflight.delete(appid);
  }
};

/** For the exit watch (AutoLaunch.tsx watchGameExits): a change that waited for the game to quit. */
export const optiApplyPending = async (appid: string, name: string): Promise<void> => {
  const rec = (await loadLog())[appid];
  if (!rec?.pending) return;
  const r = await syncOptiLaunch(appid, rec.want);
  if (r.changed && !r.error) toast(`Changed the launch options for ${name} for OptiScaler. They apply at its next start.`);
};
export const resetOptiInflight = () => { inflight = new Set(); };

const asResult = (j: Job): OptiJobResult | null => (j.result && typeof j.result === "object" ? j.result as OptiJobResult : null);
const OPTI_KINDS = ["opti-install", "opti-remove", "opti-update"];

/**
 * The OptiScaler section of a game (GameControls, after the XeSS options), only for a game in the backend's table.
 * `onWritten(text)`: the launch options changed here (GameControls shows them).
 */
export const OptiRows: FC<{ app: RunningApp; quick?: boolean; running: boolean; game: GameInfo | null; xessInstalled: boolean | null;
  onWritten: (text: string | null) => void }> = ({ app, quick, running, game, xessInstalled, onWritten }) => {
  const appid = app.appid;
  const res = useResource<OptiInfoRes>(`opti-info:${appid}`, () => opti_info(appid), { fresh: true });
  const log = useOptiLog();
  const act = useAction();
  const cur = useCurrentJob();
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const info: OptiInfo | null = res.data?.ok ? res.data.opti ?? null : null;
  const [pick, setPick] = useState<OptiChoices>(DEFAULT_CHOICES);
  useEffect(() => { setPick(readChoices(info?.choices) ?? readChoices(info?.defaults) ?? DEFAULT_CHOICES); },
    [appid, JSON.stringify(info?.choices ?? null), JSON.stringify(info?.defaults ?? null)]);
  const rec = log.data?.[appid];
  useEffect(() => { setWaiting(!!rec?.pending && running); }, [!!rec?.pending, running]);

  const installed = info?.state === "installed" || info?.state === "partial";
  const optiJob = cur?.state === "running" && OPTI_KINDS.includes(cur.kind) ? cur : null;
  const quit = running ? `Quit ${app.name} first.` : null;
  const why = quit ?? (optiJob ? "Wait until the OptiScaler task has finished." : null);
  const choices = installed ? readChoices(info?.choices) ?? pick : pick;
  const inputs = INPUTS.filter((i) => !info?.fg_inputs?.length || info.fg_inputs.includes(i.data));

  /** After a job or a choice change: the launch options to the new plan; a pending row while the game runs. */
  const syncLaunch = async (want: LaunchPlan | null, id: string, what: string, okToast?: string) => {
    setLaunchErr(null);
    const r = await syncOptiLaunch(appid, want);
    log.reload();
    if (r.waiting) { setWaiting(true); return; }
    if (r.error) setLaunchErr(r.error);
    if (r.text !== null) onWritten(r.text);
    if (!r.error) {
      notePending({ id, effect: EFFECTS[id], label: what, appid, game: app.name });
      if (okToast) toast(okToast);
    }
  };

  const startJob = async (kind: "install" | "remove" | "update", c: OptiConfirm, call: () => ReturnType<typeof opti_install>) => {
    const busy = blockedBy();
    if (busy) return busy;
    if (isRunning(appid)) return `Quit ${app.name} first.`;
    if (!(await confirm({ title: c.title, text: paragraphs(c.text), lines: c.lines, linesTitle: c.linesTitle, ok: c.ok,
      destructive: c.destructive, effect: c.effect }))) return null;
    const r = await call();
    const err = started(r);
    if (err || !r.job) return err;
    afterJob(r.job.id, (j) => {
      const out = asResult(j);
      res.reload();
      if (j.state !== "done" || !out?.ok) {
        // a failed update can stop after the remove: then OptiScaler's launch options must come out too
        if (kind === "update") {
          void opti_info(appid).then((r) => {
            if (r.ok && r.opti?.state === "none") syncLaunch(null, "game.opti_remove", "OptiScaler removed");
          }).catch(() => undefined);
        }
        return;
      }
      if (kind === "remove") syncLaunch(null, "game.opti_remove", "OptiScaler removed");
      else if (out.launch) {
        syncLaunch(out.launch, kind === "install" ? "game.opti" : "game.opti_update", kind === "install" ? "OptiScaler" : "OptiScaler update",
          kind === "install" ? readyToast(app.name, choices.fg_input, choices.fg) : undefined);
      }
    });
    return null;
  };

  const install = () => act.run("install", () => startJob("install", confirmInstall(info, app.name, pick), () => opti_install(appid, pick)));
  const remove = () => act.run("remove", () => startJob("remove", confirmRemove(info, app.name, rec), () => opti_remove(appid)));
  const update = () => act.run("update", () => startJob("update",
    { title: `Update OptiScaler to ${info?.build_wanted ?? "the new build"}?`, ok: "Update", effect: EFFECTS["game.opti_update"],
      text: [`Removes OptiScaler from ${app.name}'s folder and puts the new build in, with your choices.`, "The launch options follow if anything changed."],
      lines: info?.folder ? [`Folder: ${info.folder}`] : [], linesTitle: "Technical:" },
    () => opti_update(appid)));

  /** A choice: before the install it is only remembered here; after it, the ini and the launch options change. */
  const choose = (c: Partial<OptiChoices>, id: string, what: string) => act.run(what, async () => {
    const next = { ...choices, ...c };
    if (!installed) { setPick(next); return null; }
    if (isRunning(appid)) return `Quit ${app.name} first.`;
    const r = await opti_set(appid, next);
    if (r.opti) put<OptiInfoRes>(`opti-info:${appid}`, r);
    if (!r.ok) return r.error || "refused";
    if (r.opti?.launch) await syncLaunch(r.opti.launch, id, what);
    return null;
  });

  const overlay = (on: boolean) => act.run("overlay", async () => {
    const r = await opti_options({ overlay: on });
    if (r.opti) put<OptiInfoRes>(`opti-info:${appid}`, r);
    else res.reload();
    if (!r.ok) return r.error || "refused";
    notePending({ id: "game.opti_overlay", effect: EFFECTS["game.opti_overlay"], label: "OptiScaler's FPS counter", appid, game: app.name });
    return null;
  });

  if (!isSteamApp(appid) || !game?.opti_entry) return null;
  if (res.data && !res.data.ok) return <Problem what="OptiScaler" error={res.data.error} />;

  const lab = choiceLabels(choices);
  const pl = planLines(info?.launch ?? rec?.plan ?? info?.launch_new ?? null, rec?.dropped);
  const sources = info?.sources?.length ? info.sources : ["github.com/optiscaler/OptiScaler/wiki"];
  const statusD: DetailsSpec = {
    title: "OptiScaler",
    body: paragraphs([
      "OptiScaler sits between the game and its upscaler: when the game asks for DLSS (or XeSS), it runs XeSS or FSR 3.1 instead, and XeSS frame generation (XeFG) in place of the game's frame generation. It drives Xe Low Latency itself, so the game's own latency switch no longer decides.",
      info?.state === "other" ? "Another tool (Decky Framegen or a manual copy) has put OptiScaler into this game. Remove it with that tool; OXP3 Deck does not touch it." : null,
      info?.state === "partial" ? `Not everything could be removed. Left in the game's folder: ${(info.kept ?? []).join("; ") || "see the list below"}.` : null,
      info?.update ? `A newer pinned build is available: ${info.build_wanted}. Update keeps your choices.` : null,
      ...(info?.notes ?? []),
      "OptiScaler is GPL-3.0. It is downloaded from its GitHub release when you tap Install, pinned by its checksum, and not shipped with OXP3 Deck.",
    ]),
    lines: [
      ...(info?.build ? [`Build: ${info.build}`] : info?.build_wanted ? [`Build to install: ${info.build_wanted}`] : []),
      ...(info?.folder ? [`Folder: ${info.folder}`] : []),
      ...(info?.backed_up?.length ? [`Backed up: ${info.backed_up.join(", ")}`] : []),
      ...(info?.kept?.length ? info.kept.map((k) => `Kept: ${k}`) : []),
      ...sources.map((s) => `Source: ${s}`),
    ],
    linesTitle: "Technical:",
  };
  const installD: DetailsSpec = {
    title: "Install OptiScaler for this game",
    body: paragraphs([
      `Downloads OptiScaler (${info?.cached ? "already downloaded" : `about ${Math.round(info?.download_mb ?? 69)} MB`}) once, then puts it into the game's folder as your user. Install stops if the folder already has a dxgi.dll or another OptiScaler; the game's own files are not touched.`,
      "The steps: download and check it, unpack it with 7z or bsdtar, copy the files in, write OptiScaler.ini, then the launch options. Remove puts everything back.",
      `Takes effect: Restart the game. ${quit ?? ""}`,
      info?.why && !quit ? `Not possible now: ${info.why}` : null,
    ]),
    lines: [
      ...(pl.adds.length ? [`Adds to launch options: ${pl.adds.join(" ")}`] : []),
      `Removes from launch options: ${(info?.launch?.remove ?? ["XESS", "FSR", "FSR_FG", "force_vk_vendor"]).join(", ")} (when set)`,
      ...(info?.unpacker ? [`Unpacker: ${info.unpacker}`] : []),
    ],
    linesTitle: "Technical:",
  };
  const upD: DetailsSpec = {
    title: "Upscaler",
    body: paragraphs([
      "What OptiScaler runs when the game asks for DLSS (or XeSS). XeSS uses the XMX cores with XeSS fast mode; FSR 3.1 runs on any GPU.",
      installed ? "Changing it rewrites OptiScaler.ini in the game's folder." : "Used when you tap Install.",
      "Takes effect: Restart the game.",
    ]),
    lines: [`Upscalers Dx12Upscaler=${choices.upscaler === "fsr31" ? "ffx" : "xess"}`], linesTitle: "Technical:",
  };
  const fgD: DetailsSpec = {
    title: "Frame generation",
    body: paragraphs([
      "XeSS frame generation (XeFG) from OptiScaler, in place of the game's frame generation. Turn the game's frame generation on too (the setting below says which).",
      "3x and 4x also set the GPU vendor for DXVK, so XeFG does not fall back to 2x; this is not tested on this device yet.",
      "A frame limit caps the generated frames too. XeFG needs a borderless window, not exclusive fullscreen.",
      "Frame generation can crash some games; if a game crashes, turn it off.",
      "Takes effect: Restart the game.",
    ]),
    lines: [
      `FrameGen FGInput=${choices.fg_input} FGOutput=${choices.fg ? "xefg" : "nofg"}${choices.fg ? ` XeFG InterpolationCount=${choices.fg - 1}` : ""}`,
      ...(choices.fg ? [`XESS_FG=${choices.fg}`] : []),
      ...(choices.fg > 2 ? ["DXVK_CONFIG: dxgi.customVendorId = 8086"] : []),
    ],
    linesTitle: "Technical:",
  };
  const inputD: DetailsSpec = {
    title: "Game setting it replaces",
    body: paragraphs([
      "DLSS frame generation (default, the setup from ETA Prime's video): pick DLSS and DLSS frame generation in the game; OptiScaler runs XeSS and XeFG in their place.",
      "XeSS frame generation: pick XeSS and XeSS frame generation in the game. The game's own Xe Low Latency then stays in charge, so it may hit the same \"latency reduction is not enabled\" refusal as without OptiScaler.",
      "None: OptiScaler makes the frames from the upscaler's input itself (OptiFG). Keep the game's gamma at its default; the HUD fix is on.",
      "Takes effect: Restart the game.",
    ]),
    lines: [`FrameGen FGInput=${choices.fg_input}`], linesTitle: "Technical:",
  };
  const listD: DetailsSpec = {
    title: "In the game, once",
    body: paragraphs([...checklist(choices.fg_input, choices.fg), ...CHECKLIST_HELP]),
  };
  const overlayD: DetailsSpec = {
    title: "Show OptiScaler's FPS counter",
    body: paragraphs(["OptiScaler's own frame counter in the corner, to check that frame generation works.",
      "Global: every game with OptiScaler from OXP3 Deck. Takes effect: Restart the game."]),
    lines: ["Menu ShowFps=true"], linesTitle: "Technical:",
  };
  const updateD: DetailsSpec = { title: "Update OptiScaler", body: paragraphs([
    `Removes OptiScaler ${info?.build ?? ""} from the game's folder and puts ${info?.build_wanted ?? "the new build"} in, in one task, keeping your choices. The launch options change only where the new build needs something else.`,
    "Takes effect: Restart the game."]) };
  const removeD: DetailsSpec = { title: "Remove OptiScaler", body: paragraphs([
    "Deletes the files OptiScaler's install put in (only those unchanged since), its log files and its folder, puts back the game's files it had moved aside, and takes its launch options out again, putting back what it replaced.",
    "A file that changed since is kept and listed in OptiScaler's Details. Remove OptiScaler from each game before uninstalling OXP3 Deck.",
    "Takes effect: Restart the game."]),
    lines: [...(pl.adds.length ? [`Takes out: ${pl.adds.join(" ")}`] : []), ...(pl.removes.length && rec ? [`Puts back: ${pl.removes.join(" ")}`] : [])],
    linesTitle: "Launch options:" };
  const myJob = act.job && OPTI_KINDS.includes(act.job.kind) ? act.job : null;
  const warns = warningRows(info, game, xessInstalled);
  const below = { layout: "below" as const, childrenContainerWidth: "max" as const, bottomSeparator: "none" as const };
  const ids = ["game.opti", "game.opti_upscaler", "game.opti_fg", "game.opti_input", "game.opti_update", "game.opti_remove", "game.opti_overlay"];

  return (
    <>
      <Status ok={info ? info.state === "installed" && !info.update : null} label="OptiScaler" detail={statusLine(info)} details={statusD} />
      {!installed && info?.state !== "other" && (
        <WithDetails details={installD}>
          <ButtonItem layout="below" disabled={!!act.busy || !info || !!why || !!info.why} onClick={install}
            description={explainWhen("Runs XeSS and XeSS frame generation in place of the game's DLSS.", EFFECTS["game.opti"], why ?? info?.why ?? null)}>
            {act.busy === "install" ? "Starting…" : label("Install OptiScaler for this game", installD)}
          </ButtonItem>
        </WithDetails>
      )}
      {info?.state !== "other" && (
        <>
          <WithDetails details={upD}>
            <DropdownItem key={`opti-up-${appid}-${choices.upscaler}`} {...below} label={label("Upscaler", upD)} menuLabel="Upscaler"
              disabled={!!act.busy || !info || !!why} rgOptions={UPSCALERS} selectedOption={choices.upscaler}
              onChange={(o) => choose({ upscaler: o.data }, "game.opti_upscaler", "Upscaler")}
              description={explainWhen("What runs when the game asks for DLSS.", EFFECTS["game.opti_upscaler"], why)} />
          </WithDetails>
          <WithDetails details={fgD}>
            <DropdownItem key={`opti-fg-${appid}-${choices.fg}`} {...below} label={label("Frame generation", fgD)} menuLabel="OptiScaler frame generation"
              disabled={!!act.busy || !info || !!why} rgOptions={FGS} selectedOption={choices.fg}
              onChange={(o) => choose({ fg: o.data }, "game.opti_fg", "OptiScaler frame generation")}
              description={explainWhen(choices.fg ? "Also turn on the game's frame generation." : "No generated frames.", EFFECTS["game.opti_fg"], why)} />
          </WithDetails>
          {!quick && (
            <WithDetails details={inputD}>
              <DropdownItem key={`opti-in-${appid}-${choices.fg_input}`} {...below} label={label("Game setting it replaces", inputD)}
                menuLabel="Game setting it replaces" disabled={!!act.busy || !info || !!why} rgOptions={inputs} selectedOption={choices.fg_input}
                onChange={(o) => choose({ fg_input: o.data }, "game.opti_input", "Game setting it replaces")}
                description={explainWhen(lab.input, EFFECTS["game.opti_input"], why)} />
            </WithDetails>
          )}
        </>
      )}
      {installed && <Note label="In the game, once" details={listD}>{checklistLine(choices.fg_input, choices.fg)}</Note>}
      {!quick && installed && (
        <WithDetails details={overlayD}>
          <ToggleField label={label("Show OptiScaler's FPS counter", overlayD)} checked={!!info?.overlay} bottomSeparator="none"
            disabled={!!act.busy || !info || !!why} onChange={overlay}
            description={explainWhen("For checking frame generation works.", EFFECTS["game.opti_overlay"], why)} />
        </WithDetails>
      )}
      {installed && info?.update && (
        <WithDetails details={updateD}>
          <ButtonItem layout="below" disabled={!!act.busy || !!why} onClick={update}
            description={explainWhen("Keeps your choices.", EFFECTS["game.opti_update"], why)}>
            {act.busy === "update" ? "Starting…" : label(`Update OptiScaler to ${info.build_wanted ?? "the new build"}`, updateD)}
          </ButtonItem>
        </WithDetails>
      )}
      {installed && (
        <WithDetails details={removeD}>
          <ButtonItem layout="below" disabled={!!act.busy || !!why} onClick={remove}
            description={explainWhen("Puts the game's files and launch options back.", EFFECTS["game.opti_remove"], why)}>
            {act.busy === "remove" ? "Starting…" : label("Remove OptiScaler", removeD)}
          </ButtonItem>
        </WithDetails>
      )}
      {myJob && <JobView job={myJob} quick={quick} />}
      <Problem what="OptiScaler" error={act.error} />
      <Problem what="OptiScaler launch options" error={launchErr} />
      {waiting && rec?.pending && (
        <Status ok={null} label={`Will be added when you quit ${app.name}`} detail="OptiScaler's launch options."
          details={{ title: `Will be added when you quit ${app.name}`, body: `OXP3 Deck never changes a running game's launch options. Recorded ${when(rec.at)}; written a few seconds after the game has quit.` }} />
      )}
      <Pending ids={ids} appid={appid} />
      {info?.state !== "other" && warns.map((w) => (
        <Status key={w.label} ok={false} label={w.label} detail={w.line} details={{ title: w.label, body: w.detail }} />
      ))}
      {!installed && !info && res.loading && <Status ok={null} label="Checking OptiScaler…" />}
      {!installed && info?.why && !why && <Note>{explain(info.why)}</Note>}
    </>
  );
};
