// The 0.4 automatic launch options (DESIGN.md "Automatic launch options"): 0.6's "Set up games automatically"
// (AutoSetup.tsx) replaces its toggle and per-game dropdown, and nothing is added by them any more. What stays: the
// settings (read for the migration and for keys the user removed, `done`), and an old record's "Added: …" row with
// its Undo, which takes out only what was added, never while that game runs.
import { ButtonItem } from "@decky/ui";
import { FC, useState } from "react";

import { AutoLog, AutoRecord, AutoSettings, fitLog, hasAdded, readLog, readSettings, recordText, undo, undone } from "../autolaunch";
import { get_setting, set_setting } from "../backend";
import { EFFECTS } from "../effects";
import { getLaunchOptions, isRunning, isSteamApp, RunningApp, setLaunchOptions } from "../steam";
import { put, useResource } from "../store";
import { when } from "../util";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { explainWhen, Problem, Status } from "./Hint";

const SETTINGS = "ui_autolaunch";
const LOG = "ui_autolaunch_log";

// both settings in the store's cache, so every row shows the same and a change re-renders them
export const loadSettings = async (): Promise<AutoSettings> => readSettings(await get_setting(SETTINGS));
export const loadLog = async (): Promise<AutoLog> => readLog(await get_setting(LOG));
export const useAutoSettings = () => useResource<AutoSettings>("ui:autolaunch", loadSettings);
export const useAutoLog = () => useResource<AutoLog>("ui:autolaunch-log", loadLog);

const saveRecord = async (appid: string, rec: AutoRecord): Promise<string | null> => {
  const log = fitLog({ ...(await loadLog()), [appid]: rec });
  const r = await set_setting(LOG, log);
  if (r.ok) put("ui:autolaunch-log", log);
  return r.ok ? null : r.error;
};

/**
 * An old record's row (0.4: "Added: XESS=latest") and its Undo. `onWritten(text)`: the launch options changed here;
 * `onUndone()`: the Undo worked (an Undo makes the game Manual in the automatic setup).
 */
export const LegacyAutoRows: FC<{ app: RunningApp; running: boolean; onWritten: (text: string | null) => void; onUndone?: () => void }> =
  ({ app, running, onWritten, onUndone }) => {
    const log = useAutoLog();
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const appid = app.appid;
    const rec = log.data?.[appid];

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
        const e = await saveRecord(appid, undone(rec, Math.floor(Date.now() / 1000)));
        setErr(e);
        if (!e) onUndone?.();
      } finally {
        setBusy(false);
      }
    };

    if (!isSteamApp(appid) || !hasAdded(rec)) return null;
    const addedD: DetailsSpec = {
      title: `Added: ${recordText(rec)}`,
      body: paragraphs([...rec.why, `Added ${when(rec.at)} by the automatic launch options of OXP3 Deck 0.4. Applies from the next start.`,
        "Undo removes exactly these, unless you changed them."]),
      lines: [recordText(rec)], linesTitle: "Added to launch options:",
    };
    return (
      <>
        <Status ok label={`Added: ${recordText(rec)}`} detail="Applies from the next start." details={addedD} />
        <ButtonItem layout="below" disabled={busy || running} onClick={doUndo}
          description={explainWhen("Removes what OXP3 Deck added.", EFFECTS["game.auto_undo"], running ? `Quit ${app.name} first.` : null)}>
          {busy ? "Working…" : "Undo"}
        </ButtonItem>
        <Problem what="Automatic launch options" error={err} />
      </>
    );
  };
