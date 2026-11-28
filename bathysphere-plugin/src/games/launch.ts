// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Per-game launch options through the typed methods (SPEC §5.3 steam.apps.launchOptions): only the
 * manifest's vars (XESS, XESS_FG, XESS_LOG, MESA, force_vk_vendor, FSR, FSR_FG) and `-dx12`; hostd
 * parses and rewrites the text itself. A change while the game runs is refused there (EBUSY), so it
 * waits in storage `pendingLaunch` and is written once the game has quit. When Steam cannot take a
 * write (no L2, a shortcut, a read-back mismatch) the row offers the whole line to copy instead.
 */
import { host, type LaunchOptions, type LaunchOptionsChange } from "@bathysphere/sdk";
import { CachedMap } from "../core/cache";
import { nowSeconds } from "../core/clock";
import { asHostError, explain, type Explained } from "../core/errors";
import { appidMap, isObj, text, type Obj, Stored } from "../core/storage";

export const MANAGED_KEYS = ["XESS", "XESS_FG", "MESA", "force_vk_vendor", "XESS_LOG", "FSR", "FSR_FG"] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];
const MANAGED_ARGS = ["-dx12"];

export const launch = new CachedMap<number, LaunchOptions>((appid) => host.steam.apps.launchOptions.get(appid), 5000);

/** The value of a managed var now, or null. */
export const varOf = (lo: LaunchOptions | undefined, key: ManagedKey): string | null => lo?.managed.vars[key] ?? null;

// ---- changes waiting for a game to quit ----------------------------------------------------------

export interface Pending {
  vars: Record<string, string | null>;
  add: string[];
  remove: string[];
  name: string;
  at: number;
  /** The last write that failed, in words. */
  error: string | null;
}

function normPendingOne(r: Obj): Pending | null {
  const vars: Record<string, string | null> = {};
  if (isObj(r.vars)) {
    for (const [k, v] of Object.entries(r.vars)) {
      if ((MANAGED_KEYS as readonly string[]).includes(k) && (v === null || (typeof v === "string" && /^[A-Za-z0-9_.,:=+@^-]{1,128}$/.test(v)))) vars[k] = v as string | null;
    }
  }
  const args = (v: unknown) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === "string" && MANAGED_ARGS.includes(a)) : []);
  const p: Pending = { vars, add: args(r.add), remove: args(r.remove), name: text(r.name, 128) ?? "the game", at: typeof r.at === "number" ? r.at : 0, error: text(r.error, 300) };
  return Object.keys(p.vars).length || p.add.length || p.remove.length ? p : null;
}

export const pendingLaunch = new Stored("pendingLaunch", "Launch options waiting for a game to quit", 1, (raw: Obj) => ({ games: appidMap(raw.games, normPendingOne, 100) }));

function merge(p: Pending | undefined, c: LaunchOptionsChange, name: string): Pending {
  const out: Pending = p ? structuredClone(p) : { vars: {}, add: [], remove: [], name, at: nowSeconds(), error: null };
  Object.assign(out.vars, c.vars ?? {});
  for (const a of c.args?.add ?? []) {
    out.remove = out.remove.filter((x) => x !== a);
    if (!out.add.includes(a)) out.add.push(a);
  }
  for (const a of c.args?.remove ?? []) {
    out.add = out.add.filter((x) => x !== a);
    if (!out.remove.includes(a)) out.remove.push(a);
  }
  out.name = name;
  out.at = nowSeconds();
  return out;
}

const toChange = (p: Pending): LaunchOptionsChange => {
  const c: LaunchOptionsChange = {};
  if (Object.keys(p.vars).length) c.vars = p.vars;
  if (p.add.length || p.remove.length) c.args = { ...(p.add.length ? { add: p.add } : {}), ...(p.remove.length ? { remove: p.remove } : {}) };
  return c;
};

/** The pending change of a game, if any. */
export const pendingOf = (appid: number): Pending | undefined => pendingLaunch.value.games[String(appid)];

export type WriteResult =
  | { kind: "written"; text: string }
  | { kind: "deferred" }
  | { kind: "typo" }
  | { kind: "copy"; line: string; why: string }
  | { kind: "error"; error: Explained };

/** The last write's result per game (rows show its copy line or error). */
export const lastWrite = new Map<number, WriteResult>();

async function trySet(appid: number, change: LaunchOptionsChange): Promise<WriteResult> {
  try {
    const r = await host.steam.apps.launchOptions.set(appid, change);
    launch.get(appid).invalidate();
    return { kind: "written", text: r.text };
  } catch (e) {
    const err = asHostError(e);
    launch.get(appid).invalidate();
    if (err.code === "EBUSY") return { kind: "deferred" };
    if (err.code === "EINVAL" && /unparsed|%command/i.test(err.message)) return { kind: "typo" };
    if (err.code === "ENOTSUP" || err.code === "EPERM" || err.code === "EINTERNAL") {
      await launch.get(appid).load();
      const lo = launch.get(appid).value;
      const why = err.code === "ENOTSUP" ? "Steam's connection for writing launch options is off right now" : err.code === "EPERM" ? "Bathysphere may not write this game's launch options" : "Steam kept other text after the write";
      return { kind: "copy", line: copyLine(lo?.text ?? "", change), why };
    }
    return { kind: "error", error: explain(err) };
  }
}

/** Changes managed launch options now, or after the game quits when it runs. */
export async function changeLaunch(appid: number, name: string, change: LaunchOptionsChange, running: boolean): Promise<WriteResult> {
  const key = String(appid);
  if (running) {
    await pendingLaunch.save({ games: { ...pendingLaunch.value.games, [key]: merge(pendingOf(appid), change, name) } });
    const r: WriteResult = { kind: "deferred" };
    lastWrite.set(appid, r);
    return r;
  }
  const r = await trySet(appid, change);
  if (r.kind === "deferred") await pendingLaunch.save({ games: { ...pendingLaunch.value.games, [key]: merge(pendingOf(appid), change, name) } });
  lastWrite.set(appid, r);
  return r;
}

/** Writes a game's waiting change (after it quit). True when nothing waits any more. */
export async function flushPending(appid: number): Promise<boolean> {
  const p = pendingOf(appid);
  if (!p) return true;
  const r = await trySet(appid, toChange(p));
  lastWrite.set(appid, r);
  const games = { ...pendingLaunch.value.games };
  if (r.kind === "deferred") return false;
  if (r.kind === "written") delete games[String(appid)];
  else games[String(appid)] = { ...p, error: r.kind === "error" ? r.error.line : r.kind === "typo" ? "The launch options have a typo: fix it in Steam." : r.why };
  await pendingLaunch.save({ games });
  return r.kind === "written";
}

// ---- the whole line, for copying by hand (original copyopts.ts / launchopts.setManaged) ------------

const COMMAND = "%command%";
/** A word that needs no quotes in a shell (SPEC §5.3 steam.apps.launchOptions.set). */
const SAFE_WORD = /^[A-Za-z0-9_./=:,+@%^-]+$/;
const quote = (v: string): string => (SAFE_WORD.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);

/** Shell-like words with their raw text (quotes and backslashes keep spaces inside a word). */
function words(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !/\s/.test(s[i]!)) {
      const c = s[i]!;
      if (c === "'") i = s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1) + 1;
      else if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
        i = Math.min(i + 1, s.length);
      } else i += c === "\\" ? 2 : 1;
    }
    out.push(s.slice(start, i));
  }
  return out;
}

/**
 * Steam's own split of text without %command% (SPEC §5.3): whitespace separates words, a quote
 * groups up to its closing quote and is removed, `\` is literal. A quote with no closing one is
 * literal too (hostd refuses that text; the copy line keeps the user's character).
 */
function steamWords(s: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    const end = c === '"' || c === "'" ? s.indexOf(c, i + 1) : -1;
    if (end >= 0) {
      cur = (cur ?? "") + s.slice(i + 1, end);
      i = end;
    } else cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * The launch options with `change` applied, as the user would type them: managed vars set or
 * removed before %command% (a new one first), managed args added after the game's own arguments.
 * Every other word keeps its text and place. Text without %command% becomes "VARS %command% ARGS":
 * Steam passed those words to the game as they were, but with %command% it runs the line through a
 * shell, so each is re-quoted as one shell word as hostd does (else `$(…)` or `;` in a game
 * argument would run). Empty when no safe line exists (a quoted argument that reads as %command%).
 */
export function copyLine(textNow: string, change: LaunchOptionsChange): string {
  if (!Object.keys(change.vars ?? {}).length && !change.args?.add?.length && !change.args?.remove?.length) return textNow.trim();
  const all = words(textNow);
  const at = all.findIndex((w) => w.includes(COMMAND));
  const args = at < 0 ? steamWords(textNow) : [];
  if (args.some((w) => w.includes(COMMAND))) return "";
  let head = at < 0 ? [] : all.slice(0, at);
  let tail = at < 0 ? args.map(quote) : all.slice(at + 1);
  for (const [k, v] of Object.entries(change.vars ?? {})) {
    const isK = (w: string) => w.startsWith(`${k}=`);
    if (v === null) {
      head = head.filter((w) => !isK(w));
      continue;
    }
    const i = head.findIndex(isK);
    if (i >= 0) head[i] = `${k}=${quote(v)}`;
    else head.unshift(`${k}=${quote(v)}`);
  }
  const ctl = tail.findIndex((w) => /^(\||;|&|&&|\|\||<|>|>>|2>)$/.test(w));
  const gameArgs = ctl < 0 ? tail : tail.slice(0, ctl);
  const rest = ctl < 0 ? [] : tail.slice(ctl);
  const remove = change.args?.remove ?? [];
  const kept = gameArgs.filter((w) => !remove.includes(w));
  for (const a of change.args?.add ?? []) if (!kept.includes(a)) kept.push(a);
  tail = [...kept, ...rest];
  if (!head.length && !tail.length) return "";
  return [...head, COMMAND, ...tail].join(" ");
}
