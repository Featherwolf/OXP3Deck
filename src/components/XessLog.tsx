// "Save XeSS logs" for one run (DESIGN.md "Save XeSS logs: one run"): the per-game record in settings.json
// (ui_xess_log), the step after a game quits (AutoSetup.tsx exitFlow) and what GameControls needs to show it. The
// decisions are xesslog.ts's; this file wires them to Steam and the backend. The launch options are written here only
// after an isRunning check right before the write.
import { game_info, get_setting, set_setting } from "../backend";
import { getLaunchOptions, isRunning, isSteamApp, setLaunchOptions } from "../steam";
import { put, useResource } from "../store";
import type { GameInfoRes } from "../types";
import { toast } from "../util";
import { exitStep, kept, LOG_KEY, needsLogTime, offToast, readState, toggled, type XessLogState } from "../xesslog";

const KEY = "ui:xess-log";
const now = () => Math.floor(Date.now() / 1000);

export const loadXessLog = async (): Promise<XessLogState> => readState(await get_setting(LOG_KEY));
export const useXessLog = () => useResource<XessLogState>(KEY, loadXessLog);

const save = async (s: XessLogState): Promise<string | null> => {
  const r = await set_setting(LOG_KEY, s);
  if (r.ok) put(KEY, s);
  return r.ok ? null : r.error;
};

/** The toggle in GameControls changed XESS_LOG (on: logging counts from now; off: the record goes). */
export const noteLogToggle = async (appid: string, on: boolean): Promise<void> => {
  if (!isSteamApp(appid)) return;
  await save(toggled(await loadXessLog(), appid, on, now()));
};

/** "Keep logging on": the record says keep; the caller writes XESS_LOG=1 back. */
export const noteLogKept = async (appid: string): Promise<string | null> => save(kept(await loadXessLog(), appid, now()));

// a mounted GameControls hears the launch options this file wrote, so its rows follow
type Written = (appid: string, text: string) => void;
const written = new Set<Written>();
export const onLogWritten = (f: Written): (() => void) => { written.add(f); return () => { written.delete(f); }; };

const inflight = new Set<string>();
/**
 * After a game quits (never while it runs, checked right before the write): turn XESS_LOG off when the run wrote a
 * fresh log and the game is not set to keep logging; a toast says so and the Save XeSS logs row shows the note.
 */
export const xessLogAfterExit = async (appid: string, name: string): Promise<void> => {
  if (!isSteamApp(appid) || isRunning(appid) || inflight.has(appid)) return;
  inflight.add(appid);
  try { await afterExit(appid, name); } finally { inflight.delete(appid); }
};

const afterExit = async (appid: string, name: string): Promise<void> => {
  const text = await getLaunchOptions(appid);
  const s = await loadXessLog();
  let logAt: number | null = null;
  if (needsLogTime(s, appid, text)) {
    const r: GameInfoRes = await game_info(appid);
    if (!r.ok) return;
    put(`game:${appid}`, r);
    logAt = r.game?.last_run?.log_at ?? null;
  }
  const step = exitStep(s, appid, text, logAt, now());
  if (step.do === "nothing") return;
  if (step.do === "off") {
    // the text was read before the awaits above: another write since (OptiScaler's, the pass's) must not be undone
    if (await getLaunchOptions(appid) !== text) return;   // left on; the next exit tries again
    if (isRunning(appid)) return;
    const w = await setLaunchOptions(appid, step.text);
    if (!w.ok) return;   // left on; the next exit tries again
    written.forEach((f) => { try { f(appid, w.text ?? step.text); } catch { /* a dead listener */ } });
    if (await save(step.state) === null) toast(offToast(name));
    return;
  }
  await save(step.state);
};
