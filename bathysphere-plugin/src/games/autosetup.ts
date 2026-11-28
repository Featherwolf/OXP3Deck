// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Automatic setup (original autosetup.py and src/autosetup.ts, without OptiScaler and the Proton
 * move): with the user's one switch on, each game gets launch options known to help, only while it
 * does not run, each change recorded with its reason and an Undo. A change after which the game
 * closed within a minute (or three quick exits in a row) is undone before the next start. Games with
 * anti-cheat, online games and games the user set up by hand are left alone: a hand edit seen on any
 * pass, in OXP3 Deck or in Steam, makes the game Manual (autosetup.py _hand). Storage `auto`.
 */
import { host, type LaunchOptions } from "@bathysphere/sdk";
import { after, nowSeconds, type Timer } from "../core/clock";
import { appidMap, bool, int, isObj, text, type Obj, Stored } from "../core/storage";
import { fit } from "../core/text";
import { toast } from "../core/queue";
import { fsrSupported } from "../xess/releases";
import { xess } from "../xess/detect";
import { suggest, type GameFacts } from "./advice";
import { facts } from "./files";
import { DX12_APPIDS, DX12_ARG, knownIssues, ONLINE } from "./known";
import { changeLaunch, launch, MANAGED_KEYS } from "./launch";

/** Raised when the tables change, so games seen before are planned again. */
export const PLAN_VERSION = 1;
export const QUICK_EXIT_MS = 60_000;
export const REPEAT_EXITS = 3;
const MAX_GAMES = 300;
const MAX_CHANGES = 12;
/** Keys never set automatically: frame generation can crash a game (Monster Hunter Wilds). */
export const NEVER_AUTO: readonly string[] = ["XESS_FG", "FSR_FG"];

export type ChangeState = "live" | "undone" | "rolled_back" | "superseded";

export interface Change {
  id: string;
  at: number;
  label: string;
  why: string;
  /** Vars it set (key → value; only keys that were not set), vars it removed (key → the value before), args it added. */
  set: Record<string, string>;
  dropped: Record<string, string>;
  args: string[];
  state: ChangeState;
  /** The game ran a minute or more with it. */
  tested: boolean;
  /** Offered and accepted by the user: a quick exit does not undo it. */
  accepted: boolean;
  /** Tried again after a rollback: not undone by one quick exit. */
  kept: boolean;
}

export interface AutoGame {
  name: string;
  cls: "known" | "unknown" | "skipped";
  skipWhy: string | null;
  mode: "auto" | "manual";
  modeWhy: string | null;
  /** The user picked the mode (the select): hand-set keys then do not switch it to Manual. */
  modeByUser: boolean;
  planVersion: number;
  changes: Change[];
  quickExits: number;
  rollbackDue: string | null;
  /** The last write of this game's automatic setup that Steam did not take, in words. */
  lastError: string | null;
  at: number;
}

const s = (v: unknown, max: number) => text(v, max);
const strMap = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k, x]) => (MANAGED_KEYS as readonly string[]).includes(k) && typeof x === "string" && /^[A-Za-z0-9_.,:=+@^-]{1,128}$/.test(x))) as Record<string, string> : {};

function normChange(r: unknown): Change | null {
  if (!isObj(r) || !s(r.id, 40)) return null;
  const state = (["live", "undone", "rolled_back", "superseded"] as const).find((x) => x === r.state);
  if (!state) return null;
  return {
    id: r.id as string,
    at: int(r.at, 0, 2 ** 40) ?? 0,
    label: s(r.label, 80) ?? "launch options",
    why: s(r.why, 300) ?? "",
    set: strMap(r.set),
    dropped: strMap(r.dropped),
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => a === DX12_ARG) : [],
    state,
    tested: bool(r.tested, false),
    accepted: bool(r.accepted, false),
    kept: bool(r.kept, false),
  };
}

function normGame(r: Obj): AutoGame | null {
  const cls = (["known", "unknown", "skipped"] as const).find((x) => x === r.cls);
  if (!cls) return null;
  const changes = Array.isArray(r.changes) ? r.changes.map(normChange).filter((c): c is Change => !!c).slice(-MAX_CHANGES) : [];
  const due = s(r.rollbackDue, 40);
  return {
    name: s(r.name, 128) ?? "This game",
    cls,
    skipWhy: s(r.skipWhy, 300),
    mode: r.mode === "manual" ? "manual" : "auto",
    modeWhy: s(r.modeWhy, 200),
    modeByUser: bool(r.modeByUser, false),
    planVersion: int(r.planVersion, 0, 1000) ?? 0,
    changes,
    quickExits: int(r.quickExits, 0, 100) ?? 0,
    rollbackDue: due && changes.some((c) => c.id === due && c.state === "live") ? due : null,
    lastError: s(r.lastError, 300),
    at: int(r.at, 0, 2 ** 40) ?? 0,
  };
}

export const auto = new Stored("auto", "Automatic setup", 1, (raw: Obj) => ({
  on: raw.on === true,
  games: appidMap(raw.games, normGame, MAX_GAMES),
}));

const gameOf = (appid: number): AutoGame | undefined => auto.value.games[String(appid)];

async function saveGame(appid: number, g: AutoGame | null): Promise<void> {
  const games = { ...auto.value.games };
  if (g) games[String(appid)] = { ...g, at: nowSeconds(), changes: g.changes.slice(-MAX_CHANGES) };
  else delete games[String(appid)];
  await auto.save({ ...auto.value, games: appidMap(games, (r) => normGame(r as Obj), MAX_GAMES) });
}

export const liveChanges = (g: AutoGame | undefined): Change[] => (g?.changes ?? []).filter((c) => c.state === "live");

/** A new record (the mode Automatic until a pass or the user says otherwise). */
const newGame = (name: string, cls: AutoGame["cls"], skipWhy: string | null): AutoGame => ({
  name, cls, skipWhy, mode: "auto", modeWhy: null, modeByUser: false, planVersion: PLAN_VERSION, changes: [], quickExits: 0, rollbackDue: null, lastError: null, at: nowSeconds(),
});

/** What the user set in the managed keys that no live change accounts for (original handSet). */
export function handSet(lo: LaunchOptions, g: AutoGame | undefined): string[] {
  const ours = (k: string, v: string) => liveChanges(g).some((c) => c.set[k] === v);
  const out = Object.entries(lo.managed.vars).filter(([k, v]) => !ours(k, v)).map(([k, v]) => `${k}=${v}`);
  if (lo.managed.args.includes(DX12_ARG) && !liveChanges(g).some((c) => c.args.includes(DX12_ARG))) out.push(DX12_ARG);
  return out;
}

/**
 * The user changed what a live automatic change did (original autolaunch.ts touched): a key it set
 * is gone or different, an argument it added is gone, or a key it took out is back.
 */
export function touched(lo: LaunchOptions, g: AutoGame | undefined): boolean {
  return liveChanges(g).some(
    (c) =>
      Object.entries(c.set).some(([k, v]) => lo.managed.vars[k] !== v) ||
      c.args.some((a) => !lo.managed.args.includes(a)) ||
      Object.keys(c.dropped).some((k) => lo.managed.vars[k] !== undefined),
  );
}

/** (class, why skipped) of a game (autosetup.py _classify). */
export function classify(appid: number, name: string, f: GameFacts | undefined): { cls: AutoGame["cls"]; why: string | null } {
  if (!f || !f.installed) return { cls: "skipped", why: `${name} is not installed.` };
  if (ONLINE[appid]) return { cls: "skipped", why: `${name} is an online game, so OXP3 Deck changes nothing by itself.` };
  if (f.antiCheat) return { cls: "skipped", why: `${name} uses anti-cheat (${f.antiCheat}), so OXP3 Deck changes nothing by itself.` };
  return { cls: knownIssues(appid).length || DX12_APPIDS.includes(appid) ? "known" : "unknown", why: null };
}

export interface Plan {
  set: Record<string, string>;
  remove: string[];
  args: string[];
  why: string;
  /** "Also possible" offers: FSR on XeSS (replaces the game's signed DLL, so only when asked), GE-Proton. */
  offers: Array<{ id: "fsr" | "ge-proton"; label: string; line: string; why: string }>;
}

/** What a pass would change now (autosetup.py _build_plan, launch options only). */
export function plan(appid: number, name: string, g: AutoGame | undefined, f: GameFacts, lo: LaunchOptions, installed: boolean, fsrOk: boolean): Plan {
  const issues = knownIssues(appid);
  const never = new Set([...NEVER_AUTO, ...issues.flatMap((i) => i.autoNever)]);
  const blocked = (g?.changes ?? []).filter((c) => c.state === "rolled_back" && !c.kept);
  const blockedSet = new Set(blocked.flatMap((c) => Object.entries(c.set).map(([k, v]) => `${k}=${v}`)));
  const blockedDrop = new Set(blocked.flatMap((c) => Object.keys(c.dropped)));
  const out: Plan = { set: {}, remove: [], args: [], why: "", offers: [] };
  const whys: string[] = [];
  for (const sg of suggest(f, installed, fsrOk)) {
    if (sg.key === "FSR") {
      if (!never.has("FSR") && lo.managed.vars.FSR === undefined) out.offers.push({ id: "fsr", label: "FSR → XeSS", line: "The game's FSR runs on XeSS.", why: `${sg.why} It replaces the game's signed FidelityFX files while it runs, so OXP3 Deck does not do it by itself.` });
      continue;
    }
    if (never.has(sg.key) || blockedSet.has(`${sg.key}=${sg.value}`) || lo.managed.vars[sg.key] !== undefined) continue;
    out.set[sg.key] = sg.value;
    whys.push(sg.why);
  }
  out.remove = [...new Set(issues.flatMap((i) => i.autoDrop))].filter((k) => lo.managed.vars[k] !== undefined && !blockedDrop.has(k));
  if (out.remove.length) whys.push(`${out.remove.join(", ")} ${out.remove.length === 1 ? "is" : "are"} known to break ${name}, so ${out.remove.length === 1 ? "it is" : "they are"} taken out.`);
  const fgAfter = lo.managed.vars.XESS_FG !== undefined && !out.remove.includes("XESS_FG");
  const dx12Blocked = blocked.some((c) => c.args.includes(DX12_ARG));
  if (DX12_APPIDS.includes(appid) && fgAfter && !lo.managed.args.includes(DX12_ARG) && !dx12Blocked) {
    out.args.push(DX12_ARG);
    whys.push(`${name} keeps XeSS frame generation on only in DirectX 12.`);
  }
  if (f.systemProton && f.dlls.some((d) => d.kind === "xess")) {
    out.offers.push({ id: "ge-proton", label: "GE-Proton", line: "Its Proton lacks the XeSS add-on.", why: `${name} uses XeSS and ${f.compatTool?.name ?? "its Proton"} cannot carry the add-on; GE-Proton can. Bathysphere cannot change a game's Proton, so the card says how.` });
  }
  out.why = fit(whys.join(" "), 300);
  return out;
}

export const hasWork = (p: Plan): boolean => Object.keys(p.set).length > 0 || p.remove.length > 0 || p.args.length > 0;

/** "XESS=latest -dx12 no XESS_FG". */
export const planLabel = (p: Pick<Plan, "set" | "remove" | "args">): string =>
  [...Object.entries(p.set).map(([k, v]) => `${k}=${v}`), ...p.args, ...p.remove.map((k) => `no ${k}`)].join(" ");

const FRIENDLY: Record<string, string> = { "XESS=latest": "newer XeSS", "-dx12": "DirectX 12", "FSR=xess": "FSR on XeSS" };
export const friendly = (c: Pick<Change, "set" | "args" | "dropped">): string =>
  [...new Set([...Object.entries(c.set).map(([k, v]) => FRIENDLY[`${k}=${v}`] ?? `${k}=${v}`), ...c.args.map((a) => FRIENDLY[a] ?? a), ...(Object.keys(c.dropped).length ? ["crash-prone options out"] : [])])].join(", ");

// ---- passes ---------------------------------------------------------------------------------------

export type PassResult = "off" | "skipped" | "manual" | "running" | "rollback" | "touched" | "nothing" | "changed" | "error";

/** One pass at a time per game: a pass asked for while one runs is dropped. */
const busy = new Set<number>();

/** Writes the opposite of a change (only what it changed and the user did not change since). */
async function undoWrite(appid: number, g: AutoGame, c: Change, running: boolean): Promise<boolean> {
  const lc = launch.get(appid);
  lc.invalidate();
  await lc.load();
  const vars: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(c.set)) if (lc.value?.managed.vars[k] === v) vars[k] = null;
  for (const [k, v] of Object.entries(c.dropped)) if (lc.value?.managed.vars[k] === undefined) vars[k] = v;
  const remove = c.args.filter((a) => lc.value?.managed.args.includes(a));
  if (!Object.keys(vars).length && !remove.length) return true;
  const r = await changeLaunch(appid, g.name, { ...(Object.keys(vars).length ? { vars } : {}), ...(remove.length ? { args: { remove } } : {}) }, running);
  return r.kind === "written" || r.kind === "deferred";
}

/**
 * One pass for one game (original runPass): stops when the switch is off, the game is skipped or
 * Manual, or it runs; a rollback that is due is the only thing done then.
 */
export async function runPass(appid: number, name: string, isRunning: (appid: number) => boolean): Promise<PassResult> {
  if (!auto.value.on) return "off";
  if (busy.has(appid)) return "nothing";
  if (isRunning(appid)) return "running";
  busy.add(appid);
  try {
    const fc = facts.get(appid);
    await fc.load();
    const lc = launch.get(appid);
    lc.invalidate();
    await lc.load();
    await xess.load();
    const f = fc.value;
    const lo = lc.value;
    if (!f || !lo) return "error";
    const { cls, why } = classify(appid, name, f);
    let g: AutoGame = { ...(gameOf(appid) ?? newGame(name, cls, why)), name, cls, skipWhy: why, planVersion: PLAN_VERSION };
    // the user took over in Steam or set keys by hand (seen on every pass, not only the first): Manual
    if (cls !== "skipped" && g.mode === "auto") {
      if (touched(lo, g)) g = { ...g, mode: "manual", modeWhy: "You changed its launch options in Steam.", modeByUser: false };
      else if (!g.modeByUser && handSet(lo, g).length) g = { ...g, mode: "manual", modeWhy: "You set its launch options yourself." };
      if (g.mode === "manual") {
        await saveGame(appid, g);
        return "touched";
      }
    }
    if (cls === "skipped" || g.mode === "manual") {
      await saveGame(appid, g);
      return cls === "skipped" ? "skipped" : "manual";
    }
    if (g.rollbackDue) {
      const c = g.changes.find((x) => x.id === g.rollbackDue)!;
      if (isRunning(appid)) return "running";
      if (!(await undoWrite(appid, g, c, false))) {
        // still live: the rollback stays due and runs again at the next pass; the page shows why
        await saveGame(appid, { ...g, lastError: `Steam did not take the undo of ${c.label}; OXP3 Deck tries again in a few minutes.` });
        return "error";
      }
      c.state = "rolled_back";
      g = { ...g, rollbackDue: null, quickExits: 0, lastError: null };
      await saveGame(appid, g);
      toast(fit(`${name} closed within a minute after ${friendly(c)}.`, 64), "OXP3 Deck undid that change. Try again from the game's page.");
      return "rollback";
    }
    const p = plan(appid, name, g, f, lo, !!xess.value?.installed, fsrSupported(xess.value?.version));
    if (!hasWork(p)) {
      await saveGame(appid, g);
      return "nothing";
    }
    if (isRunning(appid)) return "running";
    const dropped = Object.fromEntries(p.remove.map((k) => [k, lo.managed.vars[k]!]));
    const vars: Record<string, string | null> = { ...p.set, ...Object.fromEntries(p.remove.map((k) => [k, null])) };
    const r = await changeLaunch(appid, name, { ...(Object.keys(vars).length ? { vars } : {}), ...(p.args.length ? { args: { add: p.args } } : {}) }, false);
    if (r.kind !== "written") {
      await saveGame(appid, { ...g, lastError: `Steam did not take ${planLabel(p)}; OXP3 Deck tries again later.` });
      return "error";
    }
    const change: Change = { id: `launch-${nowSeconds()}-${g.changes.length}`, at: nowSeconds(), label: planLabel(p), why: p.why, set: p.set, dropped, args: p.args, state: "live", tested: false, accepted: false, kept: false };
    g = { ...g, changes: [...g.changes, change], lastError: null };
    await saveGame(appid, g);
    toast(fit(`Set up ${name}: ${friendly(change)}`, 64), "Applies at its next start. Undo on the game's page.");
    return "changed";
  } finally {
    busy.delete(appid);
  }
}

// ---- user actions ---------------------------------------------------------------------------------

export async function setOn(on: boolean): Promise<boolean> {
  if (on) {
    const ok = await host.ui.confirm({
      title: "Set up games automatically?",
      body: "OXP3 Deck then sets up your games by itself, only while they are not running: right after you quit one, or when it first sees it.\n\nIt may change only XeSS launch options: newer XeSS libraries for games whose own are too old for the fast mode, DirectX 12 for games known to need it, and launch options known to crash a game taken out. Never frame generation, never for games with anti-cheat or online games, never for a game you set up yourself.\n\nEach game shows what was done and why, with Undo. If a game closes within a minute after a change, the change is undone before its next start.",
      ok: "Turn on",
      lines: ["May change: Steam launch options (only OXP3 Deck's keys)"],
    });
    if (!ok) return false;
  }
  await auto.save({ ...auto.value, on });
  return true;
}

export async function setMode(appid: number, name: string, mode: "auto" | "manual"): Promise<void> {
  const g = gameOf(appid) ?? newGame(name, "unknown", null);
  await saveGame(appid, { ...g, mode, modeWhy: mode === "manual" ? "You chose Manual." : "You chose Automatic.", modeByUser: true });
}

/** A launch option the user changed by hand on a game's page: OXP3 Deck stops setting it up. */
export async function userChanged(appid: number, name: string): Promise<void> {
  const g = gameOf(appid);
  if (g && g.mode === "auto" && g.cls !== "skipped") await saveGame(appid, { ...g, name, mode: "manual", modeWhy: "You changed its launch options here.", modeByUser: false });
}

export async function undoChange(appid: number, id: string, running: boolean): Promise<string | null> {
  const g = gameOf(appid);
  const c = g?.changes.find((x) => x.id === id);
  if (!g || !c) return null;
  if (running) return `Quit ${g.name} first.`;
  if (!(await undoWrite(appid, g, c, false))) return "Steam did not take the change; nothing was recorded.";
  c.state = "undone";
  await saveGame(appid, { ...g, mode: "manual", modeWhy: "You undid an automatic change.", modeByUser: false, rollbackDue: g.rollbackDue === c.id ? null : g.rollbackDue });
  return null;
}

/** Try again after a rollback: the change goes back in, and one quick exit does not undo it again. */
export async function tryAgain(appid: number, id: string, running: boolean): Promise<string | null> {
  const g = gameOf(appid);
  const c = g?.changes.find((x) => x.id === id);
  if (!g || !c) return null;
  const vars: Record<string, string | null> = { ...c.set, ...Object.fromEntries(Object.keys(c.dropped).map((k) => [k, null])) };
  const r = await changeLaunch(appid, g.name, { ...(Object.keys(vars).length ? { vars } : {}), ...(c.args.length ? { args: { add: c.args } } : {}) }, running);
  if (r.kind !== "written" && r.kind !== "deferred") return "Steam did not take the change.";
  Object.assign(c, { state: "live", kept: true, tested: false, at: nowSeconds() });
  await saveGame(appid, g);
  return null;
}

/** An offer the user accepted ("Use it"): recorded like an automatic change, kept through quick exits. */
export async function acceptFsr(appid: number, name: string, running: boolean): Promise<string | null> {
  const r = await changeLaunch(appid, name, { vars: { FSR: "xess" } }, running);
  if (r.kind !== "written" && r.kind !== "deferred") return "Steam did not take the change.";
  const g = gameOf(appid) ?? newGame(name, "unknown", null);
  g.changes.push({ id: `launch-${nowSeconds()}-${g.changes.length}`, at: nowSeconds(), label: "FSR=xess", why: "You chose FSR → XeSS.", set: { FSR: "xess" }, dropped: {}, args: [], state: "live", tested: false, accepted: true, kept: false });
  await saveGame(appid, g);
  return null;
}

// ---- crash bookkeeping (autosetup.py session/retry) ---------------------------------------------

/** Games that started less than a minute ago. */
const quickWindows = new Map<number, Timer>();

export function onStarted(appid: number): void {
  if (!liveChanges(gameOf(appid)).length) return;
  quickWindows.get(appid)?.cancel();
  quickWindows.set(appid, after(QUICK_EXIT_MS, () => quickWindows.delete(appid)));
}

/** A game quit: a quick exit after an untested change marks it for rollback before the next start. */
export async function onStopped(appid: number): Promise<void> {
  const g = gameOf(appid);
  if (!g || !liveChanges(g).length) return;
  const quick = quickWindows.has(appid);
  quickWindows.get(appid)?.cancel();
  quickWindows.delete(appid);
  if (!quick) {
    for (const c of liveChanges(g)) c.tested = true;
    await saveGame(appid, { ...g, quickExits: 0 });
    return;
  }
  const exits = g.quickExits + 1;
  const candidates = liveChanges(g).filter((c) => !c.accepted && (exits >= REPEAT_EXITS || (!c.tested && !c.kept)));
  const newest = candidates.sort((a, b) => b.at - a.at)[0];
  await saveGame(appid, { ...g, quickExits: exits, rollbackDue: newest?.id ?? g.rollbackDue });
}

/** Games the library scan should plan now: unseen, planned under an older version, or with a rollback due (≤ 8). */
export function scanCandidates(installed: ReadonlyArray<{ appid: number; name: string }>): Array<{ appid: number; name: string }> {
  const rank = (a: { appid: number }) => {
    const g = gameOf(a.appid);
    if (g?.rollbackDue) return 0;
    if (!g) return knownIssues(a.appid).length || DX12_APPIDS.includes(a.appid) ? 1 : 2;
    return g.planVersion < PLAN_VERSION ? 3 : 9;
  };
  return installed.filter((a) => rank(a) < 9).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

