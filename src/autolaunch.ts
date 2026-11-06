// Automatic launch options (DESIGN.md "Automatic launch options"): what to add to a game's Steam launch options, the
// record of what was added (so it is added once and Undo removes only that), and the settings. Pure, so node can test
// it (tests/js/autolaunch.test.mjs). The user's own text is never rewritten: a key is inserted as one token at the
// place setManaged would put it, and Undo cuts out only that token.
import { DX12_ARGS, fgConfigured, hasArg, managed, type ManagedKey, MANAGED_KEYS, NEVER_AUTO, parse, setArg, setManaged } from "./launchopts";
import type { AutoApplied, LaunchPlan } from "./types";

export type { AutoApplied };

export type AutoSuggest = { key: ManagedKey; value: string; why: string };
/** A game argument to add after %command% ("Start in DirectX 12"). */
export type AutoArg = { arg: string; why: string };
export type AutoRecord = {
  added: Partial<Record<ManagedKey, string>>;   // what OXP3 Deck added (and Undo removes while unchanged)
  why: string[]; at: number;                    // at: Unix seconds of the last addition or undo
  done: ManagedKey[];                           // keys added once (or undone): never added again
  undone: boolean;
  args?: string[];                              // game arguments added after %command% (Undo removes them)
  argsDone?: string[];                          // arguments added once (or undone): never added again
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
/** A game argument the automatic launch options may add: one plain word, no quoting needed anywhere. */
const SAFE_ARG = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._:=-]{0,31}$/;

/** Why the DirectX 12 argument is added (DESIGN.md "Start in DirectX 12"). */
export const DX12_WHY = "This game's XeSS frame generation stays on only in DirectX 12.";

/**
 * The game arguments the automatic launch options add for this text: the game's DirectX 12 argument (DX12_ARGS) when
 * XeSS frame generation is set in its launch options (XESS_FG, FSR_FG or FSR=xess) and the argument is not there yet.
 */
export const autoArgs = (appid: string, text: string | null | undefined): AutoArg[] => {
  const arg = DX12_ARGS[String(appid ?? "")];
  const s = text ?? "";
  return arg && fgConfigured(s) && !hasArg(s, arg) ? [{ arg, why: DX12_WHY }] : [];
};

/** "XESS=latest FSR=xess". */
export const tokensText = (added: Partial<Record<ManagedKey, string>> | AutoSuggest[]): string =>
  (Array.isArray(added) ? added.map((a) => [a.key, a.value] as const) : Object.entries(added) as [string, string][])
    .map(([k, v]) => `${k}=${v}`).join(" ");

/**
 * The launch options with each suggested key added that the text does not set and that was never added before
 * (rec.done). Nothing on a "%command" typo, for a value that would need quoting, or when the text has game arguments
 * that would have to be re-quoted to put %command% in front of them (that would rewrite the user's text).
 */
export type Plan = { text: string; added: AutoSuggest[]; args: AutoArg[] };
export const plan = (text: string, suggest: AutoSuggest[], rec: AutoRecord | undefined, args: AutoArg[] = [],
  skip: readonly ManagedKey[] = []): Plan => {
  const s = text ?? "";
  const p = parse(s);
  const none: Plan = { text: s, added: [], args: [] };
  if (p.typo) return none;
  // skip: keys OptiScaler takes out of the launch options while it is in the game (opti.ts OPTI_DROPPED / its plan)
  const keys = planKeys(s, p, (suggest ?? []).filter((a) => !skip.includes(a?.key)), rec);
  // then the game arguments, appended after the rest (setArg keeps the text as it is)
  const argsDone = new Set(rec?.argsDone ?? []);
  let out = keys.text;
  const addArgs: AutoArg[] = [];
  for (const a of args ?? []) {
    if (!a || !SAFE_ARG.test(a.arg ?? "") || argsDone.has(a.arg) || hasArg(out, a.arg)) continue;
    const next = setArg(out, a.arg, true);
    if (next === out) continue;
    out = next;
    addArgs.push(a);
  }
  return { text: out, added: keys.added, args: addArgs };
};

const planKeys = (s: string, p: ReturnType<typeof parse>, suggest: AutoSuggest[], rec: AutoRecord | undefined): { text: string; added: AutoSuggest[] } => {
  const none = { text: s, added: [] as AutoSuggest[] };
  const have = managed(p);
  const done = new Set(rec?.done ?? []);
  const seen = new Set<string>();
  const add = (suggest ?? []).filter((a) => {
    if (!a || !(MANAGED_KEYS as readonly string[]).includes(a.key) || !SAFE.test(a.value ?? "")) return false;
    if (NEVER_AUTO.includes(a.key)) return false;       // never frame generation, whatever the backend says
    if (have[a.key] !== undefined || done.has(a.key) || seen.has(a.key)) return false;
    // a key set anywhere before %command% (also an unmanaged copy) counts as set
    if (p.vars.some(([k]) => k === a.key)) return false;
    seen.add(a.key);
    return true;
  });
  if (!add.length) return none;
  return insertKeys(s, p, add) ?? none;
};

/**
 * `add` inserted as KEY=VALUE tokens after the leading assignments (as setManaged would place them), the rest of the
 * text kept byte for byte; null when the text has game arguments without %command% that would need re-quoting.
 */
const insertKeys = (s: string, p: ReturnType<typeof parse>, add: AutoSuggest[]): { text: string; added: AutoSuggest[] } | null => {
  const tokens = add.map((a) => `${a.key}=${quoteValue(a.value)}`).join(" ");
  if (!p.hasCommand) {
    if (!s.trim()) return { text: `${tokens} %command%`, added: add };
    // the game's arguments go behind %command%: only when they need no quoting there
    const next = setManaged(s, Object.fromEntries(add.map((a) => [a.key, a.value])));
    return next === `${tokens} %command% ${s.trim()}` ? { text: next, added: add } : null;
  }
  // after the leading assignments (as setManaged does), before a wrapper such as gamemoderun or %command% itself
  const firstOther = p.tokens.find((t) => t.key === null);
  const at = firstOther ? firstOther.end - firstOther.raw.length : commandStart(s, p.tokens);
  return { text: `${s.slice(0, at)}${tokens} ${s.slice(at)}`, added: add };
};

/** A value as a shell word: plain when safe, else in single quotes (a user's value put back by undoAuto). */
const quoteValue = (v: string): string => (/^[A-Za-z0-9._:,+/@%=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);

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
  let out = undoKeys(text ?? "", rec);
  for (const a of rec.args ?? []) out = setArg(out, a, false);
  return out;
};

const undoKeys = (s: string, rec: AutoRecord): string => {
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
export const record = (prev: AutoRecord | undefined, added: AutoSuggest[], now: number, args: AutoArg[] = []): AutoRecord => {
  if (!added.length && !args.length && prev) return prev;
  const done = [...new Set([...(prev?.done ?? []), ...added.map((a) => a.key)])];
  const live = prev && !prev.undone;
  const keep = live ? prev.added : {};
  const r: AutoRecord = {
    added: { ...keep, ...Object.fromEntries(added.map((a) => [a.key, a.value])) },
    why: [...(live ? prev.why : []), ...[...added, ...args].map((a) => (a.why ?? "").slice(0, 160))],
    at: now, done, undone: false,
  };
  const keptArgs = [...new Set([...(live ? prev.args ?? [] : []), ...args.map((a) => a.arg)])];
  const argsDone = [...new Set([...(prev?.argsDone ?? []), ...args.map((a) => a.arg)])];
  if (keptArgs.length) r.args = keptArgs;
  if (argsDone.length) r.argsDone = argsDone;
  return r;
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
    const words = (x: unknown): string[] => Array.isArray(x) ? x.filter((w): w is string => typeof w === "string" && SAFE_ARG.test(w)) : [];
    if (words(o.args).length) out[k].args = words(o.args);
    if (words(o.argsDone).length) out[k].argsDone = words(o.argsDone);
  }
  return out;
};

/** True when the record has something Undo can still take out. */
export const hasAdded = (rec: AutoRecord | undefined): rec is AutoRecord =>
  !!rec && !rec.undone && (Object.keys(rec.added).length > 0 || (rec.args ?? []).length > 0);

/** What a record or a plan adds, as one line: "XESS=latest -dx12". */
export const addedText = (added: Partial<Record<ManagedKey, string>> | AutoSuggest[], args: (string | AutoArg)[] = []): string =>
  [tokensText(added), ...args.map((a) => (typeof a === "string" ? a : a.arg))].filter(Boolean).join(" ");
export const recordText = (rec: AutoRecord): string => addedText(rec.added, rec.args ?? []);

/** The plan adds something. */
export const planned = (p: Plan): boolean => p.added.length > 0 || p.args.length > 0;

/** The toast after an addition. */
export const addedToast = (name: string, added: AutoSuggest[], args: AutoArg[] = []): string =>
  `Added launch options for ${name}: ${addedText(added, args)}. They apply at its next start.`;

// ---- automatic setup (DESIGN.md "Automatic setup (0.6)", "Launch-option merge rules") --------------------------------

const isKey = (k: unknown): k is ManagedKey => typeof k === "string" && (MANAGED_KEYS as readonly string[]).includes(k);
const EMPTY = (): AutoApplied => ({ set: {}, dropped: {}, args: [] });

/** Cut these spans (each a token and the whitespace after it) out of `s`. */
const cutSpans = (s: string, cut: [number, number][]): string => {
  let out = "";
  let from = 0;
  for (const [a, b] of cut.sort((x, y) => x[0] - y[0])) { out += s.slice(from, a); from = b; }
  return out + s.slice(from);
};

/**
 * The launch options after an automatic setup step: first the plan's `remove` keys that are set are cut out (each
 * token alone, as Undo cuts; their values kept in `dropped`), then the `set` keys the text lacks are added with
 * plan()'s rules (a key set with another value is the user's and stays; NEVER_AUTO and `skip` never; a key the user
 * removed after an old automatic addition, `rec.done`, neither), then the game arguments (`lp.args` and `args`).
 * `lp.dll_override` / `lp.dxvk_config` are ignored (only OptiScaler's own plan sets them). A "%command" typo: nothing.
 */
export const applyAuto = (text: string, lp: LaunchPlan, args: AutoArg[] = [], skip: readonly ManagedKey[] = [],
  rec?: AutoRecord): { text: string; applied: AutoApplied } => {
  const s = text ?? "";
  const none = { text: s, applied: EMPTY() };
  const p = parse(s);
  if (p.typo || !lp) return none;
  const set = lp.set ?? {};
  // removals first
  const dropped: Partial<Record<ManagedKey, string>> = {};
  const cut: [number, number][] = [];
  if (p.hasCommand) {
    const remove = new Set((lp.remove ?? []).filter((k) => isKey(k) && set[k] === undefined));
    for (const t of p.tokens) {
      if (t.key === null || !remove.has(t.key as ManagedKey)) continue;
      let end = t.end;
      while (end < s.length && /\s/.test(s[end])) end++;
      cut.push([t.end - t.raw.length, end]);
      dropped[t.key as ManagedKey] = t.value ?? "";
    }
  }
  let out = cut.length ? cutSpans(s, cut) : s;
  if (cut.length && out.trim() === "%command%") out = "";
  // then additions (plan's rules), then the arguments
  const suggest: AutoSuggest[] = Object.entries(set).filter(([k, v]) => isKey(k) && typeof v === "string")
    .map(([k, v]) => ({ key: k as ManagedKey, value: v as string, why: "" }));
  const words: AutoArg[] = [...(lp.args ?? []).map((a) => ({ arg: a, why: "" })), ...(args ?? [])];
  const pl = plan(out, suggest, rec, words, skip);
  const applied: AutoApplied = {
    set: Object.fromEntries(pl.added.map((a) => [a.key, a.value])),
    dropped,
    args: [...new Set(pl.args.map((a) => a.arg))],
  };
  return { text: pl.text, applied };
};

/**
 * The launch options without an automatic change: each added key whose value is still the one added goes, each added
 * argument goes, each key it took out comes back where it is absent. Text that is then only %command% becomes "".
 */
export const undoAuto = (text: string, a: AutoApplied): string => {
  let out = undo(text ?? "", { added: a?.set ?? {}, why: [], at: 0, done: [], undone: false, args: a?.args ?? [] });
  const back: AutoSuggest[] = [];
  const p = parse(out);
  for (const [k, v] of Object.entries(a?.dropped ?? {})) {
    if (!isKey(k) || typeof v !== "string" || !v) continue;
    if (p.vars.some(([name]) => name === k)) continue;
    back.push({ key: k, value: v, why: "" });
  }
  if (back.length) {
    // as one token each where the keys go, the rest byte for byte; setManaged only when that is not possible
    const ins = p.typo ? null : !out.trim() ? { text: `${back.map((b) => `${b.key}=${quoteValue(b.value)}`).join(" ")} %command%`, added: back } : insertKeys(out, p, back);
    out = ins ? ins.text : setManaged(out, Object.fromEntries(back.map((b) => [b.key, b.value])));
  }
  return out.trim() === "%command%" ? "" : out;
};

/** Whether the user changed what an automatic change did: an added key gone or changed, an argument gone, a taken-out key back. */
export const touched = (text: string | null | undefined, a: AutoApplied | null | undefined): boolean => {
  if (text === null || text === undefined || !a) return false;
  const p = parse(text);
  const have = managed(p);
  for (const [k, v] of Object.entries(a.set ?? {})) if (have[k as ManagedKey] !== v) return true;
  for (const w of a.args ?? []) if (!hasArg(text, w)) return true;
  for (const k of Object.keys(a.dropped ?? {})) if (p.vars.some(([name]) => name === k)) return true;
  return false;
};

/** An automatic change did something. */
export const appliedAny = (a: AutoApplied | null | undefined): boolean =>
  !!a && (Object.keys(a.set ?? {}).length > 0 || Object.keys(a.dropped ?? {}).length > 0 || (a.args ?? []).length > 0);

/** "XESS=latest -dx12 no XESS_FG": what it added, then what it took out. */
export const appliedText = (a: AutoApplied): string =>
  [tokensText(a.set ?? {}), ...(a.args ?? []), ...Object.keys(a.dropped ?? {}).map((k) => `no ${k}`)].filter(Boolean).join(" ");
