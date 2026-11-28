// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Background work (the manifest asks for `background: true`: power tips sample during games, the
 * after-exit work needs a running sandbox, and the daily checks need timers, SPEC §4):
 * - the live readouts, every second while a view shows them;
 * - power tips, every 5 s while a game runs (power/advisor.ts);
 * - after a game quits (3 s later, again while Steam still lists it): its waiting launch options,
 *   one-run XeSS logging, the automatic setup and its crash bookkeeping;
 * - the update check (first after 3 min, then every 10 min when due, never during a game);
 * - the library scan of the automatic setup (20 s after start, then every 10 min, never during a game);
 * - every 60 s while a surface is open, the other power programs again, and what an interrupted
 *   device check still owes is put back.
 */
import { after, now } from "./core/clock";
import { toast } from "./core/queue";
import { anyOpen, openKeys, redraw } from "./core/redraw";
import { settingOn } from "./core/settings";
import { onOxp3 } from "./device/info";
import { auto, runPass, scanCandidates } from "./games/autosetup";
import { facts, forgetFacts } from "./games/files";
import { changeLaunch, flushPending, launch, pendingLaunch } from "./games/launch";
import { anyRunning, appName, currentGame, isRunning, library } from "./games/running";
import { exitStep, setRecord, xessLog } from "./games/xesslog";
import { syncAdvisor } from "./power/advisor";
import { power, readConflicts } from "./power/apply";
import { readSensors } from "./power/live";
import { putBackOwed } from "./power/selftest";
import { checkNow, dailyDue } from "./updates/check";
import { liveViews } from "./ui/view";

const LIVE_MS = 1000;
const EXIT_DELAY_MS = 3000;
const EXIT_RETRIES = 5;
const FIRST_UPDATE_MS = 180_000;
const UPDATE_EVERY_MS = 600_000;
const FIRST_SCAN_MS = 20_000;
const SCAN_EVERY_MS = 600_000;
const HOUSEKEEPING_MS = 60_000;
/** After start, once the running games are known: waiting launch options of games that quit meanwhile. */
const LEFTOVER_MS = 5000;

// ---- live readouts ------------------------------------------------------------------------------

let liveRunning = false;

/** Starts the 1 s live readout loop if a view shows readouts (views register while rendering). */
export function syncLive(): void {
  if (liveRunning) return;
  liveRunning = true;
  after(0, liveTick);
}

async function liveTick(): Promise<void> {
  const open = openKeys();
  for (const k of [...liveViews.keys()]) if (!open.has(k)) liveViews.delete(k);
  if (liveViews.size === 0 || !onOxp3()) {
    liveRunning = false;
    return;
  }
  const gpuClocks = [...liveViews.values()].some((x) => x.gpuClocks);
  try {
    await readSensors(gpuClocks);
  } catch {
    // no sensors right now: the rows say "Reading…"; try again next second
  }
  redraw();
  after(LIVE_MS, () => void liveTick());
}

// ---- power tips -----------------------------------------------------------------------------------

/** The game to sample for tips, or null when tips should not sample now. */
const tipGame = (): number | null => (onOxp3() && settingOn("powerTips") && power.value.enabled ? currentGame() : null);

export const syncTips = (): void => syncAdvisor(tipGame);

// ---- after a game quits ---------------------------------------------------------------------------

export function afterExit(appid: number, tries = 0): void {
  after(EXIT_DELAY_MS, () => void exitFlow(appid, tries));
}

async function exitFlow(appid: number, tries: number): Promise<void> {
  if (isRunning(appid)) {
    if (tries < EXIT_RETRIES) afterExit(appid, tries + 1);
    return;
  }
  const name = appName(appid);
  await flushPending(appid);
  forgetFacts(appid);
  const lc = launch.get(appid);
  lc.invalidate();
  await lc.load();
  const lo = lc.value;
  if (lo) {
    const rec = xessLog.value.games[String(appid)];
    const on = lo.managed.vars.XESS_LOG === "1";
    let logAt: number | null = null;
    if (on && rec && !rec.keep && rec.offAt === null) {
      const fc = facts.get(appid);
      await fc.load();
      logAt = fc.value?.lastRun?.logAt ?? null;
    }
    const step = exitStep(on, rec, logAt, now());
    if (step.do === "off") {
      const r = await changeLaunch(appid, name, { vars: { XESS_LOG: null } }, isRunning(appid));
      if (r.kind === "written" || r.kind === "deferred") {
        await setRecord(appid, step.rec);
        toast("XeSS logging turned off", `For ${name} after one run. The logs stay in its prefix.`);
      }
    } else if (step.do === "record") await setRecord(appid, step.rec);
  }
  await runPass(appid, name, isRunning);
  redraw();
}

// ---- timers ----------------------------------------------------------------------------------------

async function updateTick(): Promise<void> {
  after(UPDATE_EVERY_MS, () => void updateTick());
  if (!settingOn("checkUpdates") || anyRunning() || !dailyDue()) return;
  await checkNow();
  redraw();
}

async function scanTick(): Promise<void> {
  after(SCAN_EVERY_MS, () => void scanTick());
  if (!auto.value.on || anyRunning()) return;
  library.invalidate();
  await library.load();
  for (const g of scanCandidates((library.value ?? []).map((a) => ({ appid: a.appid, name: a.name })))) {
    if (anyRunning()) break;
    await runPass(g.appid, g.name, isRunning);
  }
  redraw();
}

async function housekeeping(): Promise<void> {
  after(HOUSEKEEPING_MS, () => void housekeeping());
  if (!anyOpen() || !onOxp3()) return;
  await putBackOwed();
  await readConflicts(true);
  redraw();
}

/**
 * Launch options that waited for a game which quit while OXP3 Deck was not running (a restart, a
 * crash, a reboot): written now, since no app.stopped will come for them.
 */
async function flushLeftovers(): Promise<void> {
  for (const key of Object.keys(pendingLaunch.value.games)) {
    if (!isRunning(Number(key))) await flushPending(Number(key));
  }
  redraw();
}

/** Starts the timers (from activate). */
export function startSchedule(): void {
  after(LEFTOVER_MS, () => void flushLeftovers());
  after(FIRST_UPDATE_MS, () => void updateTick());
  after(FIRST_SCAN_MS, () => void scanTick());
  after(HOUSEKEEPING_MS, () => void housekeeping());
  syncTips();
}
