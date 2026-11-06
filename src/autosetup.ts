// Automatic setup (DESIGN.md "Automatic setup (0.6)"): the texts, which launch options the user set by hand, the queue
// of passes and the pass itself with its Steam and backend calls passed in, so node can test it with fakes
// (tests/js/autosetup.test.mjs). components/AutoSetup.tsx wires it to Steam, the backend and the rows. The backend
// decides the plan and keeps the records; this side writes launch options and the Proton, never while the game runs.
import { applyAuto, appliedAny, appliedText, autoArgs, type AutoRecord, touched, undoAuto } from "./autolaunch";
import { EFFECTS, type EffectSpec } from "./effects";
import { dx12Arg, hasArg, managed, type ManagedKey, MANAGED_KEYS, parse } from "./launchopts";
import { checklistLine, OPTI_DROPPED, type OptiLogEntry } from "./opti";
import { firstSentence } from "./text";
import type {
  AutoApplied, AutoChange, AutoChangeIn, AutoFacts, AutoGame, AutoGameRes, AutoMode, AutoOffer, AutoPlan, AutoPlanRes,
  AutoProtonNote, AutoUndoRes, Job, JobStart, LaunchPlan, OptiChoices,
} from "./types";

/** Every up-front text is at most this long. */
export const LINE_MAX = 80;
/** A game that closes this soon after starting counts as a quick exit (the backend decides; for the texts). */
export const QUICK_EXIT_S = 60;

/** `s` cut at a word to at most `max` characters, with "…". */
export const fit = (s: string, max: number = LINE_MAX): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:·-]+$/, "")}…`;
};

// ---- set by hand ---------------------------------------------------------------------------------------------------

/**
 * What in the launch options OXP3 Deck manages but did not set itself: managed keys, WINEDLLOVERRIDES / DXVK_CONFIG,
 * the game's DirectX 12 argument, less what the old automatic launch options (`autoRec`, not undone), OptiScaler's
 * log (`optiEntry`) and live automatic changes (`live`) account for. Other words (gamemoderun, --launcher-skip,
 * other variables) do not count. Non-empty: the user set the game up by hand (Manual at first sight).
 */
export const handSet = (text: string | null | undefined, autoRec?: AutoRecord | null, optiEntry?: OptiLogEntry | null,
  appid?: string | null, live: AutoApplied[] = []): string[] => {
  if (text === null || text === undefined || !text.trim()) return [];
  const p = parse(text);
  const have = managed(p);
  const ours = (k: ManagedKey, v: string): boolean =>
    (!!autoRec && !autoRec.undone && autoRec.added[k] === v)
    || optiEntry?.plan?.set?.[k] === v
    || live.some((a) => a?.set?.[k] === v);
  const out: string[] = [];
  for (const k of MANAGED_KEYS) {
    const v = have[k];
    if (v !== undefined && !ours(k, v)) out.push(`${k}=${v}`);
  }
  for (const name of ["WINEDLLOVERRIDES", "DXVK_CONFIG"]) {
    if (p.vars.some(([k]) => k === name) && !(optiEntry?.lists ?? []).includes(name)) out.push(name);
  }
  const arg = dx12Arg(appid ?? "");
  if (hasArg(text, arg)) {
    const counted = (!!autoRec && !autoRec.undone && (autoRec.args ?? []).includes(arg))
      || (optiEntry?.args ?? []).includes(arg) || (optiEntry?.plan?.args ?? []).includes(arg)
      || live.some((a) => (a?.args ?? []).includes(arg));
    if (!counted) out.push(arg);
  }
  return out;
};

// ---- texts -----------------------------------------------------------------------------------------------------------

/** The part of a change the texts name: kind and label plus what it did. */
export type ChangeLike = Pick<AutoChange, "kind" | "label"> & Partial<Pick<AutoChange, "launch" | "proton" | "short" | "why">>;

const KEY_NAMES: Record<string, string> = { "XESS=latest": "newer XeSS", "FSR=xess": "FSR on XeSS", "XESS=dp4a": "XeSS DP4a" };

/** What a change did in plain words ("OptiScaler", "DirectX 12", "newer XeSS", "GE-Proton11-11"), no variable names. */
export const friendly = (c: ChangeLike): string[] => {
  if (c.kind === "opti") return ["OptiScaler"];
  if (c.kind === "proton") return [c.proton?.to_display || c.proton?.to || c.label || "Proton"];
  const a = c.launch;
  if (!a) return ["launch options"];
  const out: string[] = [];
  for (const [k, v] of Object.entries(a.set ?? {})) out.push(KEY_NAMES[`${k}=${v}`] ?? "launch options");
  for (const w of a.args ?? []) out.push(/^-dx12$/i.test(w) ? "DirectX 12" : "a start option");
  if (Object.keys(a.dropped ?? {}).length) out.push("crash-prone options out");
  return [...new Set(out.length ? out : ["launch options"])];
};

export const liveChanges = (g: AutoGame | null | undefined): AutoChange[] =>
  (g?.changes ?? []).filter((c) => c && c.state === "live");

/** The summary row: "OptiScaler, DirectX 12 · for frame generation" (≤ 80). */
export const summaryLine = (g: AutoGame | null | undefined): string => {
  const live = liveChanges(g);
  if (!live.length) return "";
  const names = [...new Set(live.flatMap(friendly))].join(", ");
  const short = live.find((c) => c.short)?.short;
  return fit(short ? `${names} · ${short}` : names);
};

/** One row per live change: its label and the first sentence of why. */
export const changeRow = (c: ChangeLike): { label: string; line: string } => {
  const label = c.kind === "opti" ? "OptiScaler installed"
    : c.kind === "proton" ? `Proton changed to ${c.proton?.to_display || c.proton?.to || c.label} for XeSS`
    : `Launch options: ${c.label || (c.launch ? appliedText(c.launch) : "")}`;
  return { label: fit(label), line: firstSentence(c.why ?? "", LINE_MAX) || "Applies from the next start." };
};

/** The toast after a pass changed something: "Set up The Witcher 3: OptiScaler, DirectX 12. Applies at its next start." */
export const toastText = (name: string, changes: ChangeLike[], opti?: OptiChoices | null): string => {
  const names = [...new Set(changes.flatMap(friendly))].join(", ");
  const base = `Set up ${name}: ${names}. Applies at its next start.`;
  return changes.some((c) => c.kind === "opti") && opti ? `${base} ${checklistLine(opti.fg_input, opti.fg)}` : base;
};

export type ConfirmText = { title: string; text: string[]; ok: string; effect: EffectSpec; lines?: string[];
  linesTitle?: string; destructive?: boolean };

/** The one dialog before the switch turns on. */
export const confirmEnable = (user?: string | null): ConfirmText => ({
  title: "Set up games automatically?",
  ok: "Turn on",
  effect: EFFECTS["auto.global"],
  text: [
    "OXP3 Deck will set up your games by itself, only while they are not running: right after you quit one, or when it first sees it.",
    "Games it knows get their best known setup: OptiScaler where its table says it helps (The Witcher 3), DirectX 12, the launch options XeSS needs, and launch options known to crash the game taken out.",
    "Other games only get what can only help: XeSS on the fast XMX cores. OptiScaler is offered, not installed.",
    "A game that uses XeSS and whose Proton lacks the XeSS add-on is moved to the newest GE-Proton (or Proton Experimental). A Proton you picked for a game is never changed.",
    "Never for games with anti-cheat, never over an existing file, never for a game you set up yourself. Each game shows what was done and why, with Undo. If a game closes within a minute after a change, the change is undone before its next start (also when you quit it that quickly yourself).",
  ],
  lines: ["Steam launch options (only OXP3 Deck's keys)", "A game's Proton (SpecifyCompatTool)",
    `OptiScaler files in a game folder (as ${user || "your user"})`],
  linesTitle: "May change:",
});

/** The Undo dialog of one change. */
export const undoConfirm = (c: ChangeLike, name: string): ConfirmText => ({
  title: `Undo for ${name}?`,
  ok: "Undo",
  effect: EFFECTS["game.auto_undo"],
  text: [
    c.kind === "opti" ? `Removes OptiScaler from ${name}'s folder and takes its launch options out again.`
      : c.kind === "proton" ? `Puts ${name}'s Proton back to ${c.proton?.from_priority !== undefined && c.proton.from_priority >= 250 && c.proton.from ? c.proton.from : "Steam's default"}.`
      : `Puts back ${name}'s launch options as they were before (${c.launch ? appliedText(c.launch) : c.label}), only where you haven't changed them.`,
    "OXP3 Deck then sets up this game no more by itself (Manual); pick Automatic again any time.",
  ],
  lines: c.kind === "launch" && c.launch ? [appliedText(c.launch)] : c.kind === "proton" && c.proton ? [`${c.proton.to} → ${c.proton.from || "Steam's default"}`] : undefined,
  linesTitle: "Technical:",
});

/** The rollback row: "The Witcher 3 closed within a minute after OptiScaler." */
export const rollbackText = (c: ChangeLike, name: string): string =>
  fit(`${name} closed within a minute after ${friendly(c).join(", ")}.`);

/** The Proton note's row. */
export const protonLine = (note: AutoProtonNote): { label: string; line: string; detail: string } => {
  const label = note.kind === "restart" ? fit((note.line || "Restart Steam to use the new Proton").replace(/\.$/, ""), 60)
    : note.kind === "none" ? "No Proton with the XeSS add-on"
    : "Listed Proton lacks the XeSS add-on";
  const line = note.kind === "restart" ? "Steam lists a Proton only after a restart." : fit(note.line || label);
  return { label, line, detail: note.detail || note.line };
};

/** The mode row's line. */
export const modeLine = (p: Pick<AutoPlan, "class" | "skip_why" | "mode" | "mode_why"> | null | undefined): string => {
  if (!p) return "Checking…";
  if (p.class === "skipped") return fit(p.skip_why || "OXP3 Deck changes nothing by itself for this game.");
  return p.mode === "auto" ? "OXP3 Deck sets it up after you quit it."
    : fit(p.mode_why || "You set it up; OXP3 Deck changes nothing.");
};

/** The DirectX 12 arguments a rolled-back launch change added (not kept by Try again): not added again by itself. */
export const blockedArgs = (g: AutoGame | null | undefined): Set<string> =>
  new Set((g?.changes ?? []).filter((c) => c && c.kind === "launch" && c.state === "rolled_back" && !c.kept && c.launch)
    .flatMap((c) => c.launch?.args ?? []));

/**
 * The launch-option step of a pass on `text`: the plan's removals and keys, the game's DirectX 12 argument when frame
 * generation is still set after the removals (unless a rolled-back change added it), without the keys OptiScaler
 * takes out while it is in. `applied` is what would change (empty: nothing).
 */
export const launchStep = (appid: string, text: string, p: AutoPlan, optiIn: boolean, rec?: AutoRecord):
  { text: string; applied: AutoApplied } => {
  if (!p.launch) return { text, applied: { set: {}, dropped: {}, args: [] } };
  const lp = p.launch.plan;
  const afterRemove = applyAuto(text, { ...lp, set: {}, args: [] }).text;
  const no = blockedArgs(p.game);
  const args = autoArgs(appid, afterRemove).filter((a) => !no.has(a.arg));
  return applyAuto(text, lp, args, optiIn ? OPTI_DROPPED : [], rec);
};

/**
 * What the plan would do, for "Will be set up when you quit <game>": ["OptiScaler", "GE-Proton11-11", "XESS=latest"].
 * `launch`: what launchStep would change in the launch options now (only that is named); without it, the plan's keys.
 */
export const plannedLabels = (p: AutoPlan | null | undefined, launch?: AutoApplied | null): string[] => {
  if (!p) return [];
  const out: string[] = [];
  if (p.rollback) out.push(`undo ${friendly(p.rollback).join(", ")}`);
  if (p.proton) out.push(p.proton.to_display || p.proton.to);
  if (p.opti) out.push("OptiScaler");
  if (p.launch) {
    const words = launch ? (appliedAny(launch) ? [appliedText(launch)] : [])
      : (() => {
        const lp = p.launch.plan;
        return [...Object.entries(lp.set ?? {}).map(([k, v]) => `${k}=${v}`), ...(lp.args ?? []), ...(lp.remove ?? []).map((k) => `no ${k}`)];
      })();
    if (words.length) out.push(words.join(" "));
  }
  return out;
};

/** Whether the plan has anything to do (`launch`: as for plannedLabels). */
export const hasWork = (p: AutoPlan | null | undefined, launch?: AutoApplied | null): boolean =>
  !!p && (!!p.rollback || !!p.proton || !!p.opti || (!!p.launch && (launch ? appliedAny(launch) : true)));

/** The switch's one line. */
export const switchLine = (on: boolean, oldOn: boolean): string =>
  on ? "OXP3 Deck sets up games after you quit them. Undo any time."
    : oldOn ? "Replaces 'Add needed launch options automatically': turn on to keep it."
    : "Off: you set up each game yourself.";

/** The offer's confirm dialog. */
export const offerConfirm = (o: AutoOffer, name: string): ConfirmText => ({
  title: `${o.label} for ${name}?`,
  ok: "Use it",
  effect: EFFECTS["game.auto_offer"],
  text: [o.why || o.line, "It is recorded like an automatic change, with Undo. A quick exit afterwards does not undo it."],
});

// ---- the queue -------------------------------------------------------------------------------------------------------

/** One pass at a time, at most one queued or running per key (appid); a second request for a key waiting is dropped. */
export const makeQueue = () => {
  let chain: Promise<unknown> = Promise.resolve();
  const keys = new Set<string>();
  return {
    has: (k: string) => keys.has(k),
    size: () => keys.size,
    run<T>(k: string, fn: () => Promise<T>): Promise<T | null> {
      if (keys.has(k)) return Promise.resolve(null);
      keys.add(k);
      const p = chain.then(fn).finally(() => { keys.delete(k); });
      chain = p.then(() => undefined, () => undefined);
      return p.then((v) => v, () => null);
    },
    clear() { keys.clear(); chain = Promise.resolve(); },
  };
};

// ---- the pass (DESIGN.md "The pass") -------------------------------------------------------------------------------------

export type WriteRes = { ok: boolean; error: string | null; text: string | null };
export type CompatRes = { ok: boolean; error: string | null; name: string | null };

/** What a pass reads and writes; AutoSetup.tsx gives the real ones, the tests fakes. */
export type PassDeps = {
  facts: (appid: string) => Promise<AutoFacts>;
  plan: (appid: string, facts: AutoFacts) => Promise<AutoPlanRes>;
  isRunning: (appid: string) => boolean;
  getLaunchOptions: (appid: string) => Promise<string | null>;
  setLaunchOptions: (appid: string, text: string) => Promise<WriteRes>;
  setCompatTool: (appid: string, name: string) => Promise<CompatRes>;
  record: (appid: string, change: AutoChangeIn) => Promise<AutoGameRes>;
  mode: (appid: string, mode: AutoMode, why: string | null) => Promise<AutoGameRes>;
  undo: (appid: string, id: string, reason: "user" | "rollback") => Promise<AutoUndoRes>;
  optiInstall: (appid: string, accepted: boolean) => Promise<JobStart>;
  waitJob: (job: Job) => Promise<Job | null>;
  syncOpti: (appid: string, want: LaunchPlan | null) => Promise<{ error: string | null }>;
  optiIn: (appid: string) => Promise<boolean>;
  legacyRec: (appid: string) => Promise<AutoRecord | undefined>;
  toast: (text: string) => void;
};

export type PassCause = "exit" | "open" | "scan";
export type PassResult = {
  changes: ChangeLike[]; error: string | null; waiting: boolean;
  stopped: "off" | "skipped" | "manual" | "running" | "error" | "rollback" | "touched" | null;
  rolledBack: AutoChange | null; game: AutoGame | null; plan: AutoPlan | null; text: string | null;
};

const RUNNING_ERR = (name: string) => `Quit ${name} first.`;
const ERR = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Undo one change by its kind (an Undo, or a rollback after a quick exit), then tell the backend. Never while the
 * game runs. launch: undoAuto + the write; proton: the previous pick back ("" for Steam's default); opti: the
 * backend's remove job, then OptiScaler's launch options out.
 */
export const undoChange = async (d: PassDeps, appid: string, c: AutoChange, reason: "user" | "rollback", name: string):
  Promise<{ ok: boolean; error: string | null; game: AutoGame | null; text: string | null }> => {
  const fail = (error: string | null) => ({ ok: false, error: error || "did not work", game: null, text: null });
  if (d.isRunning(appid)) return fail(RUNNING_ERR(name));
  let text: string | null = null;
  if (c.kind === "launch") {
    if (!c.launch) return fail("This change has no record of what it did.");
    const now = await d.getLaunchOptions(appid);
    if (now === null) return fail("Steam did not return the launch options; nothing was changed.");
    const next = undoAuto(now, c.launch);
    if (next !== now) {
      if (d.isRunning(appid)) return fail(RUNNING_ERR(name));
      const w = await d.setLaunchOptions(appid, next);
      if (!w.ok) return fail(w.error);
      text = w.text ?? next;
    }
  } else if (c.kind === "proton") {
    if (!c.proton) return fail("This change has no record of the Proton before.");
    const back = c.proton.from_priority >= 250 ? c.proton.from : "";
    if (d.isRunning(appid)) return fail(RUNNING_ERR(name));
    const r = await d.setCompatTool(appid, back);
    if (!r.ok) return fail(r.error || "Steam did not take the Proton change.");
  }
  const u = await d.undo(appid, c.id, reason);
  if (!u.ok) return fail(u.error);
  if (c.kind === "opti") {
    if (!u.job) return fail(u.error || "The remove task did not start.");
    const j = await d.waitJob(u.job);
    if (!j || j.state !== "done" || (j.result && j.result.ok === false)) return fail(j?.error || j?.result?.error || "Removing OptiScaler did not finish.");
    const s = await d.syncOpti(appid, null);
    if (s.error) return { ok: false, error: s.error, game: u.game, text: null };
  }
  return { ok: true, error: null, game: u.game, text };
};

/** The newest live change of `kind` in a game record, else a stand-in. */
const newest = (g: AutoGame | null | undefined, kind: AutoChange["kind"]): AutoChange | null =>
  [...(g?.changes ?? [])].filter((c) => c.kind === kind && c.state === "live").sort((a, b) => b.at - a.at)[0] ?? null;

/**
 * One pass for one game (DESIGN.md "The pass", steps 1–8). Stops when the switch is off, the game is skipped or
 * Manual, or it runs (checked again right before every write); a rollback that is due is the only thing done then.
 */
export const runPass = async (d: PassDeps, appid: string, gameName: string, cause: PassCause): Promise<PassResult> => {
  let name = gameName;
  const res: PassResult = { changes: [], error: null, waiting: false, stopped: null, rolledBack: null, game: null, plan: null, text: null };
  const stop = (why: PassResult["stopped"], error: string | null = null): PassResult => ({ ...res, stopped: why, error: error ?? res.error });
  const running = () => {
    if (!d.isRunning(appid)) return false;
    res.waiting = true;
    return true;
  };
  try {
    // 1. facts and plan
    const facts = await d.facts(appid);
    const pr = await d.plan(appid, facts);
    if (!pr.ok || !pr.plan) return stop("error", pr.error || "auto_plan: no answer");
    const plan = pr.plan;
    res.plan = plan;
    res.game = plan.game;
    name = name || plan.name || `App ${appid}`;
    if (!plan.on) return stop("off");
    if (plan.class === "skipped") return stop("skipped");
    if (plan.mode === "manual") return stop("manual");
    // 2. never while it runs
    if (running()) return stop("running");
    // 3. a change the game closed quickly after: undo it first, nothing else this pass
    if (plan.rollback) {
      const u = await undoChange(d, appid, plan.rollback, "rollback", name);
      if (!u.ok) return stop("error", u.error);
      res.rolledBack = plan.rollback;
      res.game = u.game ?? res.game;
      res.text = u.text;
      d.toast(u.game?.notice || `${rollbackText(plan.rollback, name)} OXP3 Deck undid that change.`);
      return stop("rollback");
    }
    // 4. its automatic launch options changed in Steam: Manual (the keys OptiScaler takes out while it is in do not count)
    let optiIn = await d.optiIn(appid);
    const lives = liveChanges(plan.game).filter((c) => c.kind === "launch" && c.launch);
    if (lives.length) {
      const now = await d.getLaunchOptions(appid);
      const mine = (a: AutoApplied): AutoApplied => optiIn
        ? { ...a, set: Object.fromEntries(Object.entries(a.set ?? {}).filter(([k]) => !OPTI_DROPPED.includes(k as ManagedKey))) }
        : a;
      if (now !== null && lives.some((c) => touched(now, mine(c.launch!)))) {
        const m = await d.mode(appid, "manual", "You changed its launch options in Steam.");
        res.game = m.game ?? res.game;
        return stop("touched");
      }
    }
    // 5. the Proton
    if (plan.proton) {
      if (running()) return stop("running");
      const from = facts.compat;
      const r = await d.setCompatTool(appid, plan.proton.to);
      if (!r.ok) {
        res.error = "Steam did not take the Proton change.";
      } else {
        const change: AutoChangeIn = {
          kind: "proton", label: (plan.proton.to_display || plan.proton.to).slice(0, 40), why: plan.proton.why, short: "for XeSS",
          proton: { from: from?.name ?? "", from_priority: from?.priority ?? 0, to: plan.proton.to, to_display: plan.proton.to_display || plan.proton.to },
        };
        const g = await d.record(appid, change);
        if (g.ok) {
          res.game = g.game ?? res.game;
          res.changes.push(newest(g.game, "proton") ?? { ...change });
        } else {
          // not recorded means no Undo: put it back
          res.error = g.error || "auto_record refused the Proton change";
          if (!d.isRunning(appid)) await d.setCompatTool(appid, change.proton && change.proton.from_priority >= 250 ? change.proton.from : "");
        }
      }
    }
    // 6. OptiScaler (the backend's job; its launch plan through OptiScaler's own path)
    if (plan.opti) {
      if (running()) return stop("running");
      const j = await d.optiInstall(appid, false);
      if (!j.ok || !j.job) {
        res.error = j.error || "OptiScaler did not start.";
      } else {
        const done = await d.waitJob(j.job);
        if (done && done.state === "done" && done.result?.ok !== false) {
          const s = await d.syncOpti(appid, done.result?.launch ?? null);
          if (s.error) res.error = s.error;
          optiIn = true;
          res.changes.push({ kind: "opti", label: "OptiScaler", short: plan.opti.short, why: plan.opti.why });
        } else {
          res.error = done?.error || done?.result?.error || "The OptiScaler task failed.";
        }
      }
    }
    // 7. launch options
    if (plan.launch) {
      const text = await d.getLaunchOptions(appid);
      if (text === null) return stop("error", "Steam did not return the launch options, so OXP3 Deck did not change them.");
      const { text: next, applied } = launchStep(appid, text, plan, optiIn, await d.legacyRec(appid));
      if (next !== text && appliedAny(applied)) {
        if (running()) return stop("running");
        const w = await d.setLaunchOptions(appid, next);
        if (!w.ok) {
          res.error = w.error;
        } else {
          res.text = w.text ?? next;
          const change: AutoChangeIn = {
            kind: "launch", label: appliedText(applied).slice(0, 40), why: plan.launch.why, short: plan.launch.short, launch: applied,
          };
          const g = await d.record(appid, change);
          if (g.ok) {
            res.game = g.game ?? res.game;
            res.changes.push(newest(g.game, "launch") ?? { ...change });
          } else {
            res.error = g.error || "auto_record refused the launch options";
            if (!d.isRunning(appid)) {
              const back = undoAuto(res.text, applied);
              const b = await d.setLaunchOptions(appid, back);
              if (b.ok) res.text = b.text ?? back;
            }
          }
        }
      }
    }
    // 8. one toast
    if (res.changes.length) d.toast(toastText(name, res.changes, plan.opti?.choices ?? null));
    void cause;
    return res;
  } catch (e) {
    return stop("error", ERR(e));
  }
};

/** Accept an offer (a row's "Use it"): applied as an accepted change; the game stays Automatic. */
export const acceptOffer = async (d: PassDeps, appid: string, name: string, o: AutoOffer, facts: AutoFacts):
  Promise<{ ok: boolean; error: string | null; text: string | null; job: Job | null }> => {
  const fail = (error: string | null) => ({ ok: false, error: error || "did not work", text: null, job: null });
  if (d.isRunning(appid)) return fail(RUNNING_ERR(name));
  if (o.id === "opti") {
    const j = await d.optiInstall(appid, true);
    if (!j.ok || !j.job) return fail(j.error);
    const done = await d.waitJob(j.job);
    if (!done || done.state !== "done" || done.result?.ok === false) return fail(done?.error || done?.result?.error || "The OptiScaler task failed.");
    const s = await d.syncOpti(appid, done.result?.launch ?? null);
    return { ok: !s.error, error: s.error, text: null, job: done };
  }
  if (o.id === "fsr") {
    const text = await d.getLaunchOptions(appid);
    if (text === null) return fail("Steam did not return the launch options; nothing was changed.");
    const lp: LaunchPlan = { set: { FSR: "xess" }, remove: [], dll_override: null, dxvk_config: null, args: [] };
    const { text: next, applied } = applyAuto(text, lp, [], (await d.optiIn(appid)) ? OPTI_DROPPED : []);
    if (next === text || !appliedAny(applied)) return fail("FSR is set in its launch options already.");
    if (d.isRunning(appid)) return fail(RUNNING_ERR(name));
    const w = await d.setLaunchOptions(appid, next);
    if (!w.ok) return fail(w.error);
    const g = await d.record(appid, { kind: "launch", label: appliedText(applied).slice(0, 40), why: o.why || o.line, short: "FSR on XeSS", launch: applied, accepted: true });
    if (!g.ok) {
      if (!d.isRunning(appid)) await d.setLaunchOptions(appid, undoAuto(w.text ?? next, applied));
      return fail(g.error);
    }
    return { ok: true, error: null, text: w.text ?? next, job: null };
  }
  // proton: the offer's label names the target tool (as GetAvailableCompatTools lists it)
  const tool = facts.tools.find((t) => t.name === o.label || t.display === o.label || o.label.endsWith(` ${t.name}`) || o.line.includes(t.name));
  if (!tool) return fail("That Proton is not in Steam's list; restart Steam.");
  if (d.isRunning(appid)) return fail(RUNNING_ERR(name));
  const r = await d.setCompatTool(appid, tool.name);
  if (!r.ok) return fail(r.error || "Steam did not take the Proton change.");
  const from = facts.compat;
  const g = await d.record(appid, { kind: "proton", label: tool.display.slice(0, 40), why: o.why || o.line, short: "for XeSS", accepted: true,
    proton: { from: from?.name ?? "", from_priority: from?.priority ?? 0, to: tool.name, to_display: tool.display } });
  if (!g.ok) {
    if (!d.isRunning(appid)) await d.setCompatTool(appid, from && from.priority >= 250 ? from.name : "");
    return fail(g.error);
  }
  return { ok: true, error: null, text: null, job: null };
};
