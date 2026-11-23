// "Save XeSS logs" for one run (ROADMAP T1-12 / C-7, DESIGN.md "Save XeSS logs: one run"): XESS_LOG is turned off
// after a run that wrote a fresh log, unless the game is set to keep logging. Pure, so node can test it
// (tests/js/xesslog.test.mjs); components/XessLog.tsx wires it to Steam and the settings.
import { managed, parse, setManaged } from "./launchopts";

/** settings.json key: per game, when logging was turned on, whether to keep it on, and when it was turned off. */
export const LOG_KEY = "ui_xess_log";
export const LOG_MAX = 40;

export type XessLogRec = {
  on_at: number;       // Unix seconds: logging turned on (or first seen on); a log older than this is from before
  keep?: boolean;      // "Keep logging on": never turned off after a run
  off_at?: number;     // Unix seconds: turned off after a run (the note shows until the game's next run ends)
};
export type XessLogState = Record<string, XessLogRec>;

/** XESS_LOG is set to something other than 0 in the launch options. */
export const logOn = (text: string | null | undefined): boolean => {
  const v = managed(parse(text ?? "")).XESS_LOG;
  return !!v && v !== "0";
};

/** The launch options without XESS_LOG (the user's other text as it is). */
export const withoutLog = (text: string): string => setManaged(text, { XESS_LOG: null });

/** A stored ui_xess_log value, keeping only well-formed records. */
export const readState = (v: unknown): XessLogState => {
  const out: XessLogState = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const rec: XessLogRec = { on_at: typeof o.on_at === "number" && isFinite(o.on_at) ? o.on_at : 0 };
    if (o.keep === true) rec.keep = true;
    if (typeof o.off_at === "number" && isFinite(o.off_at)) rec.off_at = o.off_at;
    out[k] = rec;
  }
  return out;
};

/** The newest LOG_MAX games (the backend stores at most 4096 bytes per setting). */
export const trimState = (s: XessLogState, max: number = LOG_MAX): XessLogState => {
  const e = Object.entries(s);
  if (e.length <= max) return { ...s };
  const at = (r: XessLogRec) => Math.max(r.on_at, r.off_at ?? 0);
  return Object.fromEntries(e.sort((a, b) => at(b[1]) - at(a[1])).slice(0, max));
};

/** The toggle turned on (a fresh start: an older keep or note goes) or off (the record goes). */
export const toggled = (s: XessLogState, appid: string, on: boolean, now: number): XessLogState => {
  const out = { ...s };
  if (on) out[appid] = { on_at: now }; else delete out[appid];
  return trimState(out);
};

/** "Keep logging on": on again, and never turned off after a run. */
export const kept = (s: XessLogState, appid: string, now: number): XessLogState =>
  trimState({ ...s, [appid]: { on_at: now, keep: true } });

/** A note ends at an exit at least this long after the turn-off (so at the end of the game's next run). */
export const NOTE_MIN_S = 120;

export type ExitStep =
  | { do: "nothing" }
  | { do: "note"; state: XessLogState }              // only the settings change (a record started or a note ended)
  | { do: "off"; text: string; state: XessLogState };   // write `text` (XESS_LOG removed), then store `state`

/**
 * After `appid` has quit: its launch options `text` (null: unreadable), the newest log time `logAt` (games.py
 * last_run.log_at; null: no log), now in Unix seconds.
 * - logging off: a note from an earlier turn-off ends (it showed for one more run, NOTE_MIN_S at least); else nothing;
 * - kept on: nothing;
 * - on with no record (set by hand, or before this version): the record starts now, so the next run decides;
 * - on, with a log newer than when it was turned on: XESS_LOG is removed and the note starts;
 * - on, no fresh log (the game did not use XeSS, or a Proton without the hook): nothing, it stays on.
 */
export const exitStep = (s: XessLogState, appid: string, text: string | null, logAt: number | null | undefined, now: number): ExitStep => {
  if (text === null) return { do: "nothing" };
  const rec = s[appid];
  if (!logOn(text)) {
    // the same exit can be seen twice (the main app change and Steam's lifetime event): the note stays for a while
    if (!rec || (rec.off_at && now - rec.off_at < NOTE_MIN_S)) return { do: "nothing" };
    const out = { ...s };
    delete out[appid];
    return { do: "note", state: out };
  }
  if (rec?.keep) return { do: "nothing" };
  if (!rec || rec.off_at) return { do: "note", state: trimState({ ...s, [appid]: { on_at: now } }) };
  if (typeof logAt === "number" && logAt > rec.on_at) {
    return { do: "off", text: withoutLog(text), state: trimState({ ...s, [appid]: { on_at: rec.on_at, off_at: now } }) };
  }
  return { do: "nothing" };
};

/** Whether exitStep needs the game's log time (game_info): only while logging is on and could be turned off. */
export const needsLogTime = (s: XessLogState, appid: string, text: string | null): boolean =>
  text !== null && logOn(text) && !!s[appid] && !s[appid].keep && !s[appid].off_at;

/** What the Save XeSS logs row shows: the cost while on, the note after a turn-off. */
export type LogView = { on: boolean; keep: boolean; turnedOff: boolean };
export const logView = (s: XessLogState | null | undefined, appid: string, text: string | null | undefined): LogView => {
  const on = logOn(text);
  const rec = s?.[appid];
  return { on, keep: on && !!rec?.keep, turnedOff: !on && !!rec?.off_at };
};

export const ON_LINE = "Logging on: costs performance.";
export const KEPT_LINE = "Logging on: costs performance. Kept on.";
export const OFF_LABEL = "Logging turned off after one run";
export const offToast = (name: string) => `XeSS logging turned off for ${name || "the game"} after one run.`;
