// Automatic launch options (DESIGN.md "Automatic launch options"): when a game needs a launch option for XeSS (games.py
// `suggest`), the frontend adds only the managed variable, never while that game runs, records what it added and
// offers Undo. The pure rules are autolaunch.ts's; this file reads and writes Steam and the settings.
import { ButtonItem, DropdownItem, ToggleField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";

import {
  addedText, addedToast, autoArgs, AutoChoice, AutoLog, AutoRecord, AutoSettings, choiceOf, effectiveOn, fitLog, fitSettings,
  hasAdded, plan, planned, readLog, readSettings, record, recordText, undo, undone, withChoice,
} from "../autolaunch";
import { game_info, get_setting, set_setting } from "../backend";
import { dx12Known } from "../launchopts";
import { OPTI_DROPPED } from "../opti";
import { optiApplyPending, resetOptiInflight } from "./OptiControls";
import { EFFECTS } from "../effects";
import { getLaunchOptions, isRunning, isSteamApp, RunningApp, runningApp, setLaunchOptions, watchRunningApp } from "../steam";
import { put, useResource } from "../store";
import type { GameInfoRes } from "../types";
import { toast, when } from "../util";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { explainWhen, label, Problem, Status, WithDetails } from "./Hint";

const SETTINGS = "ui_autolaunch";
const LOG = "ui_autolaunch_log";

// both settings in the store's cache, so every row shows the same and a change re-renders them
const loadSettings = async (): Promise<AutoSettings> => readSettings(await get_setting(SETTINGS));
const loadLog = async (): Promise<AutoLog> => readLog(await get_setting(LOG));
export const useAutoSettings = () => useResource<AutoSettings>("ui:autolaunch", loadSettings);
export const useAutoLog = () => useResource<AutoLog>("ui:autolaunch-log", loadLog);

const saveSettings = async (s: AutoSettings): Promise<string | null> => {
  const v = fitSettings(s);
  const r = await set_setting(SETTINGS, v);
  if (r.ok) put("ui:autolaunch", v);
  return r.ok ? null : r.error;
};
const saveRecord = async (appid: string, rec: AutoRecord): Promise<string | null> => {
  const log = fitLog({ ...(await loadLog()), [appid]: rec });
  const r = await set_setting(LOG, log);
  if (r.ok) put("ui:autolaunch-log", log);
  return r.ok ? null : r.error;
};

export type AutoResult = { added: string | null; waiting: boolean; error: string | null };

let inflight = new Set<string>();

/**
 * Add what the game needs, when the automatic launch options are on for it and it does not run. Returns what was
 * added ("XESS=latest"), or waiting: true when the game runs (it is added once it has quit).
 */
export const autoApply = async (appid: string, name: string, opts: { quiet?: boolean } = {}): Promise<AutoResult> => {
  const none: AutoResult = { added: null, waiting: false, error: null };
  if (!isSteamApp(appid) || inflight.has(appid)) return none;
  inflight.add(appid);
  try {
    if (!effectiveOn(await loadSettings(), appid)) return none;
    const gi = await game_info(appid);
    const suggest = gi.ok ? gi.game?.suggest ?? [] : [];
    // the DirectX 12 argument depends on the launch options (frame generation set), so a known game reads them too
    if (!suggest.length && !dx12Known(appid)) return none;
    const text = await getLaunchOptions(appid);
    if (text === null) return none;                       // unreadable: writing would replace the user's options
    const rec = (await loadLog())[appid];
    // OptiScaler in the game: the keys it takes out are never added back (DESIGN.md "With xess-xmx-linux")
    const p = plan(text, suggest, rec, autoArgs(appid, text), gi.game?.opti_installed ? OPTI_DROPPED : []);
    if (!planned(p)) return none;
    // never while that game runs: checked right before the write
    if (isRunning(appid)) return { ...none, waiting: true };
    const r = await setLaunchOptions(appid, p.text);
    if (!r.ok) return { ...none, error: r.error };
    const err = await saveRecord(appid, record(rec, p.added, Math.floor(Date.now() / 1000), p.args));
    if (!opts.quiet) toast(addedToast(name, p.added, p.args));
    return { added: addedText(p.added, p.args), waiting: false, error: err };
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : String(e) };
  } finally {
    inflight.delete(appid);
  }
};

/** For index.tsx: when the main app moves away from a game that then no longer runs, autoApply it 3 s later. */
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
      // OptiScaler's waiting launch options first, then the automatic ones (one after the other: both write them)
      if (!isRunning(left.appid)) {
        optiApplyPending(left.appid, left.name).then(undefined, () => undefined)
          .then(() => autoApply(left.appid, left.name)).then(undefined, () => undefined);
      }
    }, AUTO_AFTER_EXIT_MS);
    timers.add(t);
  });
  return () => { stop(); timers.forEach((t) => clearTimeout(t)); timers.clear(); inflight = new Set(); resetOptiInflight(); };
};

const GLOBAL_TEXT = [
    "When a game needs a launch option for XeSS fast mode, OXP3 Deck adds it to the game's Steam launch options: XESS=latest for a game with XeSS older than 2.0.2.68 (or old frame generation or XeLL 1.2), FSR=xess for a game with FSR 3.1+ and no XeSS (xess-xmx-linux 20261104 or newer), and -dx12 after %command% for The Witcher 3 when XeSS frame generation is set for it (its frame generation stays on only in DirectX 12).",
    "It adds only these and never changes your own text. A key is added once per game: if you remove it, or tap Undo, it stays removed.",
    "Takes effect: from the game's next start. Never while that game runs: it is added a few seconds after you quit, or when you open the game's settings here while it is not running.",
    "Each game can override this on its own settings (Games tab).",
];
const GLOBAL_D: DetailsSpec = { title: "Add needed launch options automatically", body: paragraphs(GLOBAL_TEXT) };

/** The global toggle (Games tab top, XeSS tab). */
export const AutoGlobalToggle: FC = () => {
  const s = useAutoSettings();
  const [err, setErr] = useState<string | null>(null);
  const on = !!s.data?.on;
  return (
    <>
      <WithDetails details={GLOBAL_D}>
        <ToggleField label={label("Add needed launch options automatically", GLOBAL_D)} checked={on} disabled={!s.data}
          onChange={async (c) => setErr(await saveSettings({ on: c, games: s.data?.games ?? {} }))}
          description={explainWhen("Adds what XeSS needs for a game. Never changes your own text.", EFFECTS["auto.global"])} />
      </WithDetails>
      <Problem what="Automatic launch options" error={err} />
    </>
  );
};

const CHOICE_LABEL = (c: AutoChoice, global: boolean) =>
  c === "on" ? "On for this game" : c === "off" ? "Off for this game" : `Use global (${global ? "On" : "Off"})`;

/**
 * The game's rows under its XeSS options: its own choice, what was added (with Undo), or what waits for the game to
 * quit. `onWritten(text)`: the launch options changed here (GameControls shows them).
 */
export const AutoLaunchRows: FC<{ app: RunningApp; running: boolean; onWritten: (text: string | null) => void }> = ({ app, running, onWritten }) => {
  const s = useAutoSettings();
  const log = useAutoLog();
  const gi = useResource<GameInfoRes>(`game:${app.appid}`, () => game_info(app.appid));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const tried = useRef<string | null>(null);
  const appid = app.appid;
  const on = effectiveOn(s.data, appid);
  const choice = choiceOf(s.data, appid);
  const rec = log.data?.[appid];
  const suggest = gi.data?.ok ? gi.data.game?.suggest ?? [] : [];
  const needs = suggest.length > 0 || dx12Known(appid);    // something may be added for this game

  // opening the controls of a game that does not run applies what it needs, once per mount
  useEffect(() => {
    if (!s.data || !on || running || tried.current === appid || !needs) return;
    tried.current = appid;
    autoApply(appid, app.name).then((r) => {
      if (r.error) setErr(r.error);
      if (r.added) { log.reload(); getLaunchOptions(appid).then(onWritten); }
    });
  }, [appid, on, running, !!s.data, needs]);

  // while it runs: what will be added once it has quit
  useEffect(() => {
    setWaiting(null);
    if (!running || !on || !needs) return;
    let alive = true;
    getLaunchOptions(appid).then((text) => {
      if (!alive || text === null) return;
      const p = plan(text, suggest, rec, autoArgs(appid, text), gi.data?.game?.opti_installed ? OPTI_DROPPED : []);
      setWaiting(planned(p) ? addedText(p.added, p.args) : null);
    });
    return () => { alive = false; };
  }, [appid, running, on, suggest.map((x) => x.key).join(","), JSON.stringify(rec ?? null)]);

  const pick = async (c: AutoChoice) => {
    setErr(await saveSettings(withChoice(s.data, appid, c)));
    tried.current = null;          // a new choice may apply now
  };

  const doUndo = async () => {
    if (!rec || !hasAdded(rec)) return;
    setErr(null);
    const ok = await confirm({ title: `Undo for ${app.name}?`, ok: "Undo", effect: EFFECTS["game.auto_undo"],
      text: `Removes ${recordText(rec)} from the game's launch options (only where you haven't changed them). OXP3 Deck won't add them again for this game.` });
    if (!ok) return;
    setBusy(true);
    try {
      const text = await getLaunchOptions(appid);
      if (text === null) { setErr("Steam did not return the launch options; nothing was changed."); return; }
      // never while that game runs: checked right before the write
      if (isRunning(appid)) { setErr(`Quit ${app.name} first.`); return; }
      const next = undo(text, rec);
      if (next !== text) {
        const r = await setLaunchOptions(appid, next);
        if (!r.ok) { setErr(r.error); return; }
        onWritten(r.text ?? next);
      }
      setErr(await saveRecord(appid, undone(rec, Math.floor(Date.now() / 1000))));
    } finally {
      setBusy(false);
    }
  };

  if (!isSteamApp(appid)) return null;
  const choiceD: DetailsSpec = { title: "Add launch options automatically",
    body: paragraphs(["This game's own choice; \"Use global\" follows the toggle on the Games tab.", ...GLOBAL_TEXT]) };
  const addedD: DetailsSpec | null = hasAdded(rec) ? {
    title: `Added: ${recordText(rec)}`,
    body: paragraphs([...rec.why, `Added ${when(rec.at)}. Applies from the next start.`, "Undo removes exactly these, unless you changed them."]),
    lines: [recordText(rec)], linesTitle: "Added to launch options:",
  } : null;
  return (
    <>
      <WithDetails details={choiceD}>
        <DropdownItem label={label("Add launch options automatically", choiceD)} menuLabel="Add launch options automatically"
          layout="below" childrenContainerWidth="max" bottomSeparator="none" disabled={!s.data}
          rgOptions={(["global", "on", "off"] as AutoChoice[]).map((c) => ({ data: c, label: CHOICE_LABEL(c, !!s.data?.on) }))}
          selectedOption={choice} onChange={(o) => pick(o.data as AutoChoice)}
          description={explainWhen(on ? "Adds what XeSS needs for this game." : "Nothing is added for this game.", EFFECTS["game.auto"])} />
      </WithDetails>
      {hasAdded(rec) && addedD && (
        <>
          <Status ok label={`Added: ${recordText(rec)}`} detail="Applies from the next start." details={addedD} />
          <ButtonItem layout="below" disabled={busy || running} onClick={doUndo}
            description={explainWhen("Removes what OXP3 Deck added.", EFFECTS["game.auto_undo"], running ? `Quit ${app.name} first.` : null)}>
            {busy ? "Working…" : "Undo"}
          </ButtonItem>
        </>
      )}
      {waiting && <Status ok={null} label={`Will be added when you quit ${app.name}`} detail={waiting} />}
      <Problem what="Automatic launch options" error={err} />
    </>
  );
};
