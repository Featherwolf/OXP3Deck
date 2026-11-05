// Automatic launch options (DESIGN.md "Automatic launch options"): what to add to a game's Steam launch options, the
// record of what was added (so it is added once and Undo removes only that), and the settings. Pure, so node can test
// it (tests/js/autolaunch.test.mjs). The user's own text is never rewritten: a key is inserted as one token at the
// place setManaged would put it, and Undo cuts out only that token.
import { managed, type ManagedKey, MANAGED_KEYS, parse, setManaged } from "./launchopts";

export type AutoSuggest = { key: ManagedKey; value: string; why: string };
export type AutoRecord = {
  added: Partial<Record<ManagedKey, string>>;   // what OXP3 Deck added (and Undo removes while unchanged)
  why: string[]; at: number;                    // at: Unix seconds of the last addition or undo
  done: ManagedKey[];                           // keys added once (or undone): never added again
  undone: boolean;
};
export type AutoSettings = { on: boolean; games: Record<string, boolean> };   // settings.json ui_autolaunch
export type AutoLog = Record<string, AutoRecord>;                            // settings.json ui_autolaunch_log

export const LOG_MAX = 20;

/** Whether the automatic launch options act for this game: its own choice, else the global toggle (off by default). */
export const effectiveOn = (s: AutoSettings | null | undefined, appid: string): boolean => {
  const g = s?.games?.[appid];
  return typeof g === "boolean" ? g : !!s?.on;
};

export type AutoChoice = "global" | "on" | "off";
export const choiceOf = (s: AutoSettings | null | undefined, appid: string): AutoChoice => {
  const g = s?.games?.[appid];
  return g === true ? "on" : g === false ? "off" : "global";
};
/** The settings after the per-game dropdown picked `c`. */
export const withChoice = (s: AutoSettings | null | undefined, appid: string, c: AutoChoice): AutoSettings => {
  const games = { ...(s?.games ?? {}) };
  if (c === "global") delete games[appid]; else games[appid] = c === "on";
  return { on: !!s?.on, games };
};
/** A stored ui_autolaunch value as AutoSettings (anything else: the defaults). */
export const readSettings = (v: unknown): AutoSettings => {
  const o = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const games: Record<string, boolean> = {};
  if (o.games && typeof o.games === "object") {
    for (const [k, b] of Object.entries(o.games as Record<string, unknown>)) if (typeof b === "boolean" && /^\d+$/.test(k)) games[k] = b;
  }
  return { on: o.on === true, games };
};

const SAFE = /^[A-Za-z0-9._-]{1,32}$/;

/** "XESS=latest FSR=xess". */
export const tokensText = (added: Partial<Record<ManagedKey, string>> | AutoSuggest[]): string =>
  (Array.isArray(added) ? added.map((a) => [a.key, a.value] as const) : Object.entries(added) as [string, string][])
    .map(([k, v]) => `${k}=${v}`).join(" ");

/**
 * The launch options with each suggested key added that the text does not set and that was never added before
 * (rec.done). Nothing on a "%command" typo, for a value that would need quoting, or when the text has game arguments
 * that would have to be re-quoted to put %command% in front of them (that would rewrite the user's text).
 */
export const plan = (text: string, suggest: AutoSuggest[], rec: AutoRecord | undefined): { text: string; added: AutoSuggest[] } => {
  const s = text ?? "";
  const p = parse(s);
  const none = { text: s, added: [] as AutoSuggest[] };
  if (p.typo) return none;
  const have = managed(p);
  const done = new Set(rec?.done ?? []);
  const seen = new Set<string>();
  const add = (suggest ?? []).filter((a) => {
    if (!a || !(MANAGED_KEYS as readonly string[]).includes(a.key) || !SAFE.test(a.value ?? "")) return false;
    if (have[a.key] !== undefined || done.has(a.key) || seen.has(a.key)) return false;
    // a key set anywhere before %command% (also an unmanaged copy) counts as set
    if (p.vars.some(([k]) => k === a.key)) return false;
    seen.add(a.key);
    return true;
  });
  if (!add.length) return none;
  const tokens = tokensText(add);
  if (!p.hasCommand) {
    if (!s.trim()) return { text: `${tokens} %command%`, added: add };
    // the game's arguments go behind %command%: only when they need no quoting there
    const next = setManaged(s, Object.fromEntries(add.map((a) => [a.key, a.value])));
    return next === `${tokens} %command% ${s.trim()}` ? { text: next, added: add } : none;
  }
  // after the leading assignments (as setManaged does), before a wrapper such as gamemoderun or %command% itself
  const firstOther = p.tokens.find((t) => t.key === null);
  const at = firstOther ? firstOther.end - firstOther.raw.length : commandStart(s, p.tokens);
  return { text: `${s.slice(0, at)}${tokens} ${s.slice(at)}`, added: add };
};

/** Where the %command% token starts: after the last token before it, past the spaces. */
const commandStart = (s: string, tokens: { end: number }[]): number => {
  let i = tokens.length ? tokens[tokens.length - 1].end : 0;
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/**
 * The launch options without what `rec` added, for each key whose value is still what was added (a value the user
 * changed since stays). Only those tokens and the space after them go; text that is then only %command% becomes "".
 */
export const undo = (text: string, rec: AutoRecord): string => {
  const s = text ?? "";
  const p = parse(s);
  if (!p.hasCommand) return s;
  const cut: [number, number][] = [];
  for (const t of p.tokens) {
    if (t.key === null) continue;
    const want = rec.added[t.key as ManagedKey];
    if (want === undefined || t.value !== want) continue;
    let end = t.end;
    while (end < s.length && /\s/.test(s[end])) end++;
    cut.push([t.end - t.raw.length, end]);
  }
  if (!cut.length) return s;
  let out = "";
  let from = 0;
  for (const [a, b] of cut) { out += s.slice(from, a); from = b; }
  out += s.slice(from);
  return out.trim() === "%command%" ? "" : out;
};

/** The record after an addition (or, with `added` empty, the previous one unchanged). `now`: Unix seconds. */
export const record = (prev: AutoRecord | undefined, added: AutoSuggest[], now: number): AutoRecord => {
  if (!added.length && prev) return prev;
  const done = [...new Set([...(prev?.done ?? []), ...added.map((a) => a.key)])];
  const keep = prev && !prev.undone ? prev.added : {};
  return {
    added: { ...keep, ...Object.fromEntries(added.map((a) => [a.key, a.value])) },
    why: [...(prev && !prev.undone ? prev.why : []), ...added.map((a) => (a.why ?? "").slice(0, 160))],
    at: now, done, undone: false,
  };
};

/** The record after Undo: nothing counts as added any more, the keys stay done. */
export const undone = (rec: AutoRecord, now: number): AutoRecord => ({ ...rec, at: now, undone: true });

/** The log with at most `max` games, the newest `at` kept. */
export const trimLog = (log: AutoLog, max: number = LOG_MAX): AutoLog => {
  const entries = Object.entries(log ?? {}).filter(([, r]) => r && typeof r === "object");
  if (entries.length <= max) return Object.fromEntries(entries);
  return Object.fromEntries(entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, max));
};

/** The backend stores at most 4096 bytes per setting: the log, trimmed to LOG_MAX games and then to `bytes`. */
export const fitLog = (log: AutoLog, bytes = 3800): AutoLog => {
  let out = trimLog(log);
  while (Object.keys(out).length > 1 && JSON.stringify(out).length > bytes) out = trimLog(out, Object.keys(out).length - 1);
  return out;
};

/** At most this many per-game choices are kept (the same 4096-byte limit). */
export const GAMES_MAX = 150;
export const fitSettings = (s: AutoSettings): AutoSettings => {
  const keys = Object.keys(s.games);
  return keys.length <= GAMES_MAX ? s : { on: s.on, games: Object.fromEntries(keys.slice(-GAMES_MAX).map((k) => [k, s.games[k]])) };
};

/** A stored ui_autolaunch_log value, keeping only well-formed records. */
export const readLog = (v: unknown): AutoLog => {
  const out: AutoLog = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const added: Partial<Record<ManagedKey, string>> = {};
    if (o.added && typeof o.added === "object") {
      for (const [key, val] of Object.entries(o.added as Record<string, unknown>)) {
        if ((MANAGED_KEYS as readonly string[]).includes(key) && typeof val === "string") added[key as ManagedKey] = val;
      }
    }
    out[k] = {
      added,
      why: Array.isArray(o.why) ? o.why.filter((w): w is string => typeof w === "string") : [],
      at: typeof o.at === "number" ? o.at : 0,
      done: Array.isArray(o.done) ? o.done.filter((d): d is ManagedKey => (MANAGED_KEYS as readonly string[]).includes(d as string)) : [],
      undone: o.undone === true,
    };
  }
  return out;
};

/** True when the record has something Undo can still take out. */
export const hasAdded = (rec: AutoRecord | undefined): rec is AutoRecord => !!rec && !rec.undone && Object.keys(rec.added).length > 0;

/** The toast after an addition. */
export const addedToast = (name: string, added: AutoSuggest[]): string =>
  `Added launch options for ${name}: ${tokensText(added)}. They apply at its next start.`;
