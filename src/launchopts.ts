// Steam launch options: read and change the variables OXP3 Deck manages before %command%, and keep every other
// token as the user wrote it. Pure functions with no imports, so tests/js can run this file under node as it is.

export type ManagedKey = "XESS" | "XESS_FG" | "MESA" | "force_vk_vendor" | "XESS_LOG" | "FSR" | "FSR_FG";

/** The variables the plugin manages (xess-xmx-linux docs/launch-options.md). FSR and FSR_FG need 20261104+. */
export const MANAGED_KEYS: readonly ManagedKey[] = ["XESS", "XESS_FG", "MESA", "force_vk_vendor", "XESS_LOG", "FSR", "FSR_FG"];
export const FSR_KEYS: readonly ManagedKey[] = ["FSR", "FSR_FG"];
/** Keys OXP3 Deck never adds by itself (automatic launch options, Copy launch options): frame generation can crash
 * a game (Monster Hunter Wilds), so only the user turns it on. games.py NEVER_SUGGESTED is the same list. */
export const NEVER_AUTO: readonly ManagedKey[] = ["XESS_FG", "FSR_FG"];

/** The values xess-xmx-linux reads (MESA takes a driver version or a prefix of one, e.g. 26.1). */
export const KNOWN_VALUES: Partial<Record<ManagedKey, readonly string[]>> = {
  XESS: ["latest", "dp4a"],
  XESS_FG: ["2", "3", "4", "5", "6", "7", "8"],
  force_vk_vendor: ["-1"],
  XESS_LOG: ["1"],
  FSR: ["xess"],
  FSR_FG: ["xess", "inject"],
};

export type Token = { raw: string; key: string | null; value: string | null; end: number };

export type Parsed = {
  vars: [string, string][];   // KEY=VALUE tokens before %command% (values without their quotes)
  others: string[];           // the other tokens before %command% (wrappers such as gamemoderun), as written
  after: string;              // the text after %command% (the game's arguments), as written
  hasCommand: boolean;
  typo: boolean;              // "%command" without the closing %: Steam then passes everything as game arguments
  tokens: Token[];            // every token before %command%, in order
  command: string;            // the token holding %command%, as written ("" without one)
};

const COMMAND = "%command%";
const TYPO = /%command(?!%)/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/** Split like a shell does (quotes and backslashes keep spaces inside a token), keeping each token's raw text. */
const tokenize = (s: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        const close = s.indexOf("'", i + 1);
        i = close < 0 ? s.length : close + 1;
      } else if (c === "\"") {
        i++;
        while (i < s.length && s[i] !== "\"") i += s[i] === "\\" ? 2 : 1;
        i = Math.min(i + 1, s.length);
      } else if (c === "\\") {
        i = Math.min(i + 2, s.length);
      } else {
        i++;
      }
    }
    const raw = s.slice(start, i);
    const m = ASSIGN.exec(raw);
    out.push({ raw, key: m ? m[1] : null, value: m ? unquote(m[2]) : null, end: i });
  }
  return out;
};

/** A shell word without its quoting: 'a b' and "a b" and a\ b are all `a b`. */
export const unquote = (w: string): string => {
  let r = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === "'") {
      const close = w.indexOf("'", i + 1);
      const end = close < 0 ? w.length : close;
      r += w.slice(i + 1, end);
      i = end;
    } else if (c === "\"") {
      i++;
      while (i < w.length && w[i] !== "\"") {
        if (w[i] === "\\" && i + 1 < w.length && "\"\\$`".includes(w[i + 1])) i++;
        r += w[i];
        i++;
      }
    } else if (c === "\\" && i + 1 < w.length) {
      r += w[++i];
    } else {
      r += c;
    }
  }
  return r;
};

/** A value as a shell word: plain when it is safe, else in single quotes. */
const quote = (v: string): string => (/^[A-Za-z0-9._:,+/@%=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);

/** Spaces, tabs and line ends; not a no-break space (U+00A0), which is part of a word. */
const ARG_GAP = /[ \t\r\n]+/;

/**
 * The words of text Steam passes to the game without a shell (no %command%): split at ARG_GAP, a quote (' or ")
 * groups words up to its closing quote and is dropped, a backslash is an ordinary character (RC-3: `C:\Games\a.ini`
 * stays as it is). null when a quote is not closed.
 */
type Span = { word: string; start: number; end: number };
const argSpans = (s: string): Span[] | null => {
  const words: Span[] = [];
  let w: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (ARG_GAP.test(c)) {
      if (w !== null) words.push({ word: w, start, end: i });
      w = null;
      continue;
    }
    if (w === null) { w = ""; start = i; }
    if (c === "'" || c === "\"") {
      const close = s.indexOf(c, i + 1);
      if (close < 0) return null;
      w += s.slice(i + 1, close);
      i = close;
    } else {
      w += c;
    }
  }
  if (w !== null) words.push({ word: w, start, end: s.length });
  return words;
};
const argWords = (s: string): string[] | null => argSpans(s)?.map((w) => w.word) ?? null;

/**
 * Game arguments written without %command% (Steam passed them to the game as they are), as literal shell words to
 * put behind %command%: with %command% Steam runs the line through a shell, where ( ) $ & ; * \ and quotes are
 * syntax. Quotes group words as before ("Player One" stays one argument); with an unclosed quote every word is taken
 * as it is.
 */
const literalArgs = (s: string): string =>
  (argWords(s) ?? s.split(ARG_GAP).filter(Boolean)).map(quote).join(" ");

export const parse = (str: string): Parsed => {
  const s = str ?? "";
  const all = tokenize(s);
  const at = all.findIndex((t) => t.raw.includes(COMMAND));
  const typo = TYPO.test(s);
  if (at < 0) {
    return { vars: [], others: [], after: s.trim(), hasCommand: false, typo, tokens: [], command: "" };
  }
  const tokens = all.slice(0, at);
  return {
    vars: tokens.filter((t) => t.key !== null).map((t) => [t.key as string, t.value as string]),
    others: tokens.filter((t) => t.key === null).map((t) => t.raw),
    after: s.slice(all[at].end).trim(),
    hasCommand: true,
    typo,
    tokens,
    command: all[at].raw,
  };
};

/** The managed variables that are set (the last one wins, as in a shell). */
export const managed = (p: Parsed): Partial<Record<ManagedKey, string>> => {
  const r: Partial<Record<ManagedKey, string>> = {};
  for (const [k, v] of p.vars) if ((MANAGED_KEYS as readonly string[]).includes(k)) r[k as ManagedKey] = v;
  return r;
};

/**
 * Set (a string) or remove (null or "") managed variables; every other token keeps its place and quoting. Text
 * without %command% is the game's arguments, so the result is "VARS %command% ARGS", each argument quoted as a
 * literal word (literalArgs). Nothing left but %command%
 * gives "". A "%command" typo is left alone (the string comes back unchanged): fixTypo() is the user's choice.
 */
export const setManaged = (str: string, changes: Partial<Record<ManagedKey, string | null>>): string => setVars(str, changes);

/** setManaged for any variable name (WINEDLLOVERRIDES, DXVK_CONFIG for OptiScaler); the same rules. */
export const setVars = (str: string, changes: Record<string, string | null | undefined>): string => {
  const s = str ?? "";
  const p = parse(s);
  if (p.typo && !p.hasCommand) return s;
  let tokens = p.tokens.slice();
  const command = p.hasCommand ? p.command : COMMAND;
  const after = p.hasCommand ? p.after : literalArgs(s);    // all of it: trim() would drop a no-break space
  let changed = false;
  for (const [key, value] of Object.entries(changes) as [string, string | null | undefined][]) {
    if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value === null || value === "") {
      const kept = tokens.filter((t) => t.key !== key);
      if (kept.length !== tokens.length) changed = true;
      tokens = kept;
      continue;
    }
    const raw = `${key}=${quote(value)}`;
    const next: Token[] = [];
    let placed = false;
    for (const t of tokens) {
      if (t.key !== key) { next.push(t); continue; }
      if (placed) { changed = true; continue; }   // a second copy would win in the shell: drop it
      placed = true;
      if (t.value === value) { next.push(t); continue; }   // same value: keep the user's spelling of it
      changed = true;
      next.push({ raw, key, value, end: -1 });
    }
    if (!placed) {
      // after the leading assignments, so a wrapper such as gamemoderun does not take it as an argument
      const at = next.findIndex((t) => t.key === null);
      next.splice(at < 0 ? next.length : at, 0, { raw, key, value, end: -1 });
      changed = true;
    }
    tokens = next;
  }
  if (!changed) return s;
  const head = tokens.map((t) => t.raw);
  if (!head.length && command === COMMAND && !after) return "";
  return [...head, command, ...(after ? [after] : [])].join(" ");
};

/** "%command" (no closing %) to "%command%"; offered behind a button, never applied on its own. */
export const fixTypo = (str: string): string => (str ?? "").replace(/%command(?!%)/g, COMMAND);

/** FSR / FSR_FG arrived in xess-xmx-linux 20261104 (folder tags are dates, sometimes with a -N suffix). */
export const fsrSupported = (version: string | null | undefined): boolean => {
  const m = /^(\d{8})/.exec(version ?? "");
  return !!m && Number(m[1]) >= 20261104;
};

/** "26.3.0-rc2" -> "26.3": what MESA= takes, and what stays valid when an update brings a newer build. */
export const driverPrefix = (version: string): string => {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
};

// ---- game arguments after %command% ("Start in DirectX 12", DESIGN.md "Start in DirectX 12") ------------------------

/**
 * Known DirectX 12 arguments per Steam appid. Add a game only with a source for its argument in a comment.
 * 292030 The Witcher 3 (next-gen update): "-dx12" after %command% starts its DirectX 12 renderer (owner report,
 * ONEXPLAYER 3 with GE-Proton11-11, November 2026: the XeSS frame generation menu option stays on only with it,
 * together with --launcher-skip).
 */
export const DX12_ARGS: Readonly<Record<string, string>> = { "292030": "-dx12" };
/** The argument the manual toggle uses for a game not in DX12_ARGS (not every game knows it). */
export const DX12_DEFAULT = "-dx12";
export const dx12Arg = (appid: string | null | undefined): string => DX12_ARGS[String(appid ?? "")] ?? DX12_DEFAULT;
export const dx12Known = (appid: string | null | undefined): boolean => String(appid ?? "") in DX12_ARGS;

/**
 * Where the game's own arguments end in text with %command%: at the first shell control operator after %command%
 * (| ; & outside quotes, not the & of a redirection such as 2>&1 or &>, a line end, or a # comment). What follows
 * belongs to another command ("%command% | tee log": an argument at the very end would go to tee). s.length without one.
 */
const argsEnd = (s: string): number => {
  const c0 = s.indexOf(COMMAND);
  if (c0 < 0) return s.length;
  for (let i = c0 + COMMAND.length; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const close = s.indexOf("'", i + 1); if (close < 0) return s.length; i = close; continue; }
    if (c === "\"") {
      i++;
      while (i < s.length && s[i] !== "\"") i += s[i] === "\\" ? 2 : 1;
      if (i >= s.length) return s.length;
      continue;
    }
    if (c === "|" || c === ";" || c === "\n" || c === "\r") return i;
    if (c === "&" && s[i - 1] !== ">" && s[i - 1] !== "<" && s[i + 1] !== ">") return i;
    if (c === "#" && /\s/.test(s[i - 1] ?? "")) return i;
  }
  return s.length;
};

/** Where the game's arguments are in `s`, each with its unquoted word and its place (null: an unclosed quote). */
const gameArgs = (s: string): Span[] | null => {
  const all = tokenize(s);
  const at = all.findIndex((t) => t.raw.includes(COMMAND));
  if (at < 0) return TYPO.test(s) ? [] : argSpans(s);
  const end = argsEnd(s);
  const head = tokenize(s.slice(0, end));
  const cmd = head.findIndex((t) => t.raw.includes(COMMAND));
  return head.slice(cmd + 1).map((t) => ({ word: unquote(t.raw), start: t.end - t.raw.length, end: t.end }));
};

/** A space unless the text ends with one already (a word is appended to the text as it is). */
const gap = (s: string): string => (/[ \t\r\n]$/.test(s) ? "" : " ");

/** Whether the game gets `arg` as one of its arguments (after %command%, or the whole text without one). */
export const hasArg = (str: string, arg: string): boolean => {
  if (!arg) return false;
  return (gameArgs(str ?? "") ?? []).some((w) => w.word === arg);
};

/**
 * Add `arg` as the game's last argument (on) or take out every copy of it (off). The user's text stays as it is:
 * an addition is appended to the end (as a literal shell word behind %command%, or as it is to text without %command%, which
 * Steam passes to the game unchanged), a removal cuts out only that word and the space in front of it. Empty text
 * becomes "%command% ARG"; text that is then only %command% becomes "". A "%command" typo is left alone.
 */
export const setArg = (str: string, arg: string, on: boolean): string => {
  const s = str ?? "";
  if (!arg) return s;
  const p = parse(s);
  if (p.typo && !p.hasCommand) return s;
  if (on) {
    if (hasArg(s, arg)) return s;
    if (!s.trim()) return `${COMMAND} ${quote(arg)}`;
    if (!p.hasCommand) {
      // without %command% Steam passes the text to the game as it is: a word with a space or quote cannot go in
      if (/[\s'"]/.test(arg) || argSpans(s) === null) return s;
      return `${s}${gap(s)}${arg}`;
    }
    const end = argsEnd(s);
    if (end >= s.length) return `${s}${gap(s)}${quote(arg)}`;
    // before a pipe, ";", "&&" or a comment: the last of the game's own arguments, the rest stays as it is
    let a = end;
    while (a > 0 && /[ \t]/.test(s[a - 1])) a--;
    return `${s.slice(0, a)} ${quote(arg)}${s.slice(a)}`;
  }
  const spans = (gameArgs(s) ?? []).filter((w) => w.word === arg);
  if (!spans.length) return s;
  let out = "";
  let from = 0;
  for (const w of spans) {
    let a = w.start;
    while (a > from && /\s/.test(s[a - 1])) a--;
    out += s.slice(from, a);
    from = w.end;
  }
  out += s.slice(from);
  if (!p.hasCommand) out = out.replace(/^\s+/, "");
  return out.trim() === COMMAND ? "" : out;
};

/** XeSS frame generation is set for the game in its launch options (XESS_FG, or an FSR route that brings it in). */
export const fgConfigured = (str: string): boolean => {
  const m = managed(parse(str ?? ""));
  return (!!m.XESS_FG && m.XESS_FG !== "0") || !!m.FSR_FG || m.FSR === "xess";
};

// ---- list variables (OptiScaler: WINEDLLOVERRIDES "dxgi=n,b", DXVK_CONFIG "dxgi.customVendorId = 8086") -------------

/** The value of variable `name` before %command% (the last copy wins, as in a shell), or undefined. */
export const varValue = (str: string, name: string): string | undefined => {
  let v: string | undefined;
  for (const [k, x] of parse(str ?? "").vars) if (k === name) v = x;
  return v;
};

/** One entry of a list value compared without spaces ("a = 1" is "a=1"). */
const entryKey = (e: string): string => e.replace(/\s+/g, "");
const entries = (v: string, sep: string): string[] => v.split(sep).map((e) => e.trim()).filter(Boolean);

/** Whether variable `name` holds `entry` as one of its `sep`-separated entries. */
export const hasListEntry = (str: string, name: string, entry: string, sep = ";"): boolean => {
  const v = varValue(str, name);
  return v !== undefined && entries(v, sep).some((e) => entryKey(e) === entryKey(entry));
};

/**
 * Add (on) or take out (off) one entry of a list variable before %command% (WINEDLLOVERRIDES, DXVK_CONFIG), keeping
 * the user's other entries in their order: on appends it to an existing value (or adds the variable, quoted as a
 * literal shell word); off takes out that entry only, and the whole variable when nothing else is left in it. Every
 * other token stays as written; a "%command" typo is left alone.
 */
export const setListEntry = (str: string, name: string, entry: string, on: boolean, sep = ";"): string => {
  const s = str ?? "";
  const e = entry.trim();
  if (!e) return s;
  const v = varValue(s, name);
  const list = v === undefined ? [] : entries(v, sep);
  const has = list.some((x) => entryKey(x) === entryKey(e));
  if (on) {
    if (has) return s;
    return setVars(s, { [name]: [...list, e].join(sep) });
  }
  if (!has) return s;
  const left = list.filter((x) => entryKey(x) !== entryKey(e));
  return setVars(s, { [name]: left.length ? left.join(sep) : null });
};
