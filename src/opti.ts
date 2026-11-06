// OptiScaler per game (DESIGN.md "OptiScaler (0.5)"): the launch-option plan the backend returns, applied to and
// taken out of a game's Steam launch options without touching the user's own text, the choices' labels, the in-game
// checklist and the texts of the rows and dialogs. Pure, so node can test it (tests/js/opti.test.mjs). The backend
// never writes launch options; components/OptiControls.tsx reads and writes Steam.
import { hasArg, hasListEntry, managed, type ManagedKey, MANAGED_KEYS, parse, setArg, setListEntry, setManaged } from "./launchopts";
import type { EffectSpec } from "./effects";
import type { GameInfo, LaunchPlan, OptiChoices, OptiFg, OptiFgInput, OptiInfo, OptiUpscaler } from "./types";

/** The keys an OptiScaler game drops (DESIGN.md "With xess-xmx-linux"); the backend's plan says it too. */
export const OPTI_DROPPED: readonly ManagedKey[] = ["XESS", "FSR", "FSR_FG", "force_vk_vendor"];
/** OptiScaler's own dxgi.dll is loaded first: "native, then builtin" (OptiScaler's setup_linux.sh prints it). */
export const dllEntry = (dll: string): string => `${dll}=n,b`;
export const LIST_SEP = ";";

/** What was changed for one game (settings.json ui_opti_log[appid]), so Remove and a choice change undo only that. */
export type OptiLogEntry = {
  plan: LaunchPlan | null;                          // the plan as applied (null: nothing applied yet)
  dropped: Partial<Record<ManagedKey, string>>;     // the user's values the plan took out or replaced
  args: string[];                                   // game arguments the plan added (not the ones already there)
  lists: string[];                                  // list variables an entry was added to (WINEDLLOVERRIDES, DXVK_CONFIG)
  at: number;                                       // Unix seconds
  pending: boolean;                                 // a change waits for the game to quit ...
  want: LaunchPlan | null;                          // ... to this plan (null: OptiScaler removed: undo all)
  before?: string;                                  // the launch options before the first apply, and what OXP3 Deck
  after?: string;                                   // wrote last: unchanged since, Remove puts `before` back exactly
};
/** Longer launch options are not kept for the exact restore (the log has 4096 bytes for 20 games). */
export const TEXT_MAX = 400;
const keepText = (before: string | undefined, after: string): Pick<OptiLogEntry, "before" | "after"> =>
  before !== undefined && before.length <= TEXT_MAX && after.length <= TEXT_MAX ? { before, after } : {};
export type OptiLog = Record<string, OptiLogEntry>;
export const LOG_KEY = "ui_opti_log";
export const LOG_MAX = 20;

export type Applied = { text: string; dropped: Partial<Record<ManagedKey, string>>; args: string[]; lists: string[] };

const isKey = (k: unknown): k is ManagedKey => typeof k === "string" && (MANAGED_KEYS as readonly string[]).includes(k);

/**
 * The launch options with `plan` applied: the `remove` keys taken out and `set` keys written (the user's old value
 * of either kept in `dropped`), WINEDLLOVERRIDES and DXVK_CONFIG gaining one entry each (the user's own entries
 * stay), the game arguments appended. Applying it twice changes nothing more. A "%command" typo: unchanged.
 */
export const applyPlan = (text: string, plan: LaunchPlan): Applied => {
  const s = text ?? "";
  const none: Applied = { text: s, dropped: {}, args: [], lists: [] };
  const p = parse(s);
  if (p.typo) return none;
  const have = managed(p);
  const dropped: Partial<Record<ManagedKey, string>> = {};
  const changes: Partial<Record<ManagedKey, string | null>> = {};
  for (const k of plan.remove ?? []) {
    if (!isKey(k) || (plan.set ?? {})[k] !== undefined) continue;
    if (have[k] !== undefined) { dropped[k] = have[k]; changes[k] = null; }
  }
  for (const [k, v] of Object.entries(plan.set ?? {})) {
    if (!isKey(k) || typeof v !== "string" || !v) continue;
    if (have[k] !== undefined && have[k] !== v) dropped[k] = have[k];
    if (have[k] !== v) changes[k] = v;
  }
  let out = Object.keys(changes).length ? setManaged(s, changes) : s;
  const lists: string[] = [];
  for (const [name, entry] of listEntries(plan)) {
    if (hasListEntry(out, name, entry, LIST_SEP)) continue;
    const next = setListEntry(out, name, entry, true, LIST_SEP);
    if (next !== out) { out = next; lists.push(name); }
  }
  const args: string[] = [];
  for (const a of plan.args ?? []) {
    if (!a || hasArg(out, a)) continue;
    const next = setArg(out, a, true);
    if (next !== out) { out = next; args.push(a); }
  }
  return { text: out, dropped, args, lists };
};

const listEntries = (plan: LaunchPlan | null | undefined): [string, string][] => [
  ...(plan?.dll_override ? [["WINEDLLOVERRIDES", dllEntry(plan.dll_override)] as [string, string]] : []),
  ...(plan?.dxvk_config ? [["DXVK_CONFIG", plan.dxvk_config] as [string, string]] : []),
];

export type UndoKeep = { set?: Partial<Record<ManagedKey, string>>; args?: string[]; lists?: [string, string][] };

/**
 * The launch options without what `plan` added: each `set` key whose value is still the plan's, the list entries
 * the log says were added, the arguments the log says were added. Then each `dropped` value is put back where that
 * key is absent now (a value the user set since stays). `keep`: what a following plan writes again (a choice
 * change), left in place. A "%command" typo: unchanged.
 */
export const undoPlan = (text: string, plan: LaunchPlan, rec: Pick<OptiLogEntry, "dropped" | "args" | "lists"> | null | undefined,
  keep: UndoKeep = {}): string => {
  const s = text ?? "";
  if (parse(s).typo) return s;
  const have = managed(parse(s));
  const changes: Partial<Record<ManagedKey, string | null>> = {};
  for (const [k, v] of Object.entries(plan.set ?? {})) {
    if (!isKey(k) || have[k] !== v || (keep.set ?? {})[k] === v) continue;
    changes[k] = null;
  }
  let out = Object.keys(changes).length ? setManaged(s, changes) : s;
  const added = new Set(rec?.lists ?? []);
  for (const [name, entry] of listEntries(plan)) {
    if (!added.has(name) || (keep.lists ?? []).some(([n, e]) => n === name && e === entry)) continue;
    out = setListEntry(out, name, entry, false, LIST_SEP);
  }
  for (const a of rec?.args ?? []) {
    if ((keep.args ?? []).includes(a)) continue;
    out = setArg(out, a, false);
  }
  const now = managed(parse(out));
  const back: Partial<Record<ManagedKey, string>> = {};
  for (const [k, v] of Object.entries(rec?.dropped ?? {})) {
    if (!isKey(k) || typeof v !== "string" || now[k] !== undefined) continue;
    if (keep.set && keep.set[k] !== undefined) continue;
    back[k] = v;
  }
  if (Object.keys(back).length) out = setManaged(out, back);
  return out;
};

/**
 * A choice change or an update: from what `rec` applied to the `next` plan, changing only the difference. The user's
 * dropped values stay recorded while the next plan still takes them out; the entries and arguments the next plan
 * also needs stay where they are.
 */
export const changePlan = (text: string, rec: OptiLogEntry, next: LaunchPlan, now: number): { text: string; entry: OptiLogEntry } => {
  if (!rec.plan) {
    const a = applyPlan(text, next);
    return { text: a.text, entry: { ...entryOf(next, a, now, text), dropped: { ...a.dropped, ...rec.dropped } } };
  }
  const keepLists = listEntries(next);
  const stays = (k: string) => (next.remove ?? []).includes(k as ManagedKey) || (next.set ?? {})[k as ManagedKey] !== undefined;
  const dropped = Object.fromEntries(Object.entries(rec.dropped ?? {}).filter(([k]) => stays(k))) as Partial<Record<ManagedKey, string>>;
  const restore = Object.fromEntries(Object.entries(rec.dropped ?? {}).filter(([k]) => !stays(k))) as Partial<Record<ManagedKey, string>>;
  const undone = undoPlan(text, rec.plan, { dropped: restore, args: rec.args, lists: rec.lists },
    { set: next.set, args: next.args, lists: keepLists });
  const a = applyPlan(undone, next);
  const keptArgs = (rec.args ?? []).filter((x) => (next.args ?? []).includes(x));
  const keptLists = (rec.lists ?? []).filter((n) => keepLists.some(([m]) => m === n));
  return {
    text: a.text,
    entry: {
      plan: next,
      dropped: { ...a.dropped, ...dropped },          // the user's first value wins over one the old plan wrote
      args: [...new Set([...keptArgs, ...a.args])],
      lists: [...new Set([...keptLists, ...a.lists])],
      at: now, pending: false, want: null,
      ...keepText(rec.after === text ? rec.before : undefined, a.text),
    },
  };
};

/** The log entry after applying a plan for the first time. */
export const entryOf = (plan: LaunchPlan, a: Applied, now: number, before?: string): OptiLogEntry =>
  ({ plan, dropped: a.dropped, args: a.args, lists: a.lists, at: now, pending: false, want: null, ...keepText(before, a.text) });

/** The entry while a change waits for the game to quit. */
export const pendingEntry = (rec: OptiLogEntry | undefined, want: LaunchPlan | null, now: number): OptiLogEntry =>
  ({ ...(rec ?? { plan: null, dropped: {}, args: [], lists: [] }), at: now, pending: true, want });

/**
 * The undo for Remove: the exact text from before the install when the launch options are still what OXP3 Deck
 * wrote last (nothing changed by hand since); otherwise only what the plan added comes out (undoPlan).
 */
export const undoEntry = (text: string, rec: OptiLogEntry): string => {
  if (rec.before !== undefined && rec.after !== undefined && rec.after === (text ?? "")) return rec.before;
  return rec.plan ? undoPlan(text, rec.plan, rec) : text ?? "";
};

export type Sync = { text: string; entry: OptiLogEntry | null };
/**
 * The launch options and the log entry after bringing them to `want` (null: OptiScaler removed): first apply, a
 * choice change or update, or the undo. Nothing applied and nothing wanted: unchanged, no entry.
 */
export const syncPlan = (text: string, rec: OptiLogEntry | undefined, want: LaunchPlan | null, now: number): Sync => {
  const applied = rec?.plan ?? null;
  if (want && !applied) {
    const a = applyPlan(text, want);
    return { text: a.text, entry: { ...entryOf(want, a, now, text), dropped: { ...a.dropped, ...(rec?.dropped ?? {}) } } };
  }
  if (want && rec) return changePlan(text, rec, want, now);
  if (applied && rec) return { text: undoEntry(text, rec), entry: null };
  return { text: text ?? "", entry: null };
};

/** What a plan adds and takes out, for Details and the confirm dialog ("Adds to launch options: …"). */
export const planLines = (plan: LaunchPlan | null | undefined, dropped?: Partial<Record<ManagedKey, string>>): { adds: string[]; removes: string[] } => {
  if (!plan) return { adds: [], removes: [] };
  const adds = [
    ...Object.entries(plan.set ?? {}).map(([k, v]) => `${k}=${v}`),
    ...listEntries(plan).map(([n, e]) => `${n}: ${e}`),
    ...(plan.args ?? []),
  ];
  const removes = dropped
    ? Object.entries(dropped).map(([k, v]) => `${k}=${v}`)
    : (plan.remove ?? []).filter((k) => (plan.set ?? {})[k] === undefined).map((k) => `${k}=…`);
  return { adds, removes };
};

// ---- the log (settings.json ui_opti_log, at most 4096 bytes) -------------------------------------------------------

const words = (x: unknown, re: RegExp): string[] => (Array.isArray(x) ? x.filter((w): w is string => typeof w === "string" && re.test(w)) : []);
const SAFE_ARG = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._:=-]{0,31}$/;
const SAFE_VAL = /^[A-Za-z0-9._,=:;+ -]{1,64}$/;

/** A stored plan, or null when it is not one. */
export const readPlan = (v: unknown): LaunchPlan | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const set: Partial<Record<ManagedKey, string>> = {};
  if (o.set && typeof o.set === "object") {
    for (const [k, x] of Object.entries(o.set as Record<string, unknown>)) if (isKey(k) && typeof x === "string" && SAFE_VAL.test(x)) set[k] = x;
  }
  const str = (x: unknown, re: RegExp) => (typeof x === "string" && re.test(x) ? x : null);
  return {
    set,
    remove: Array.isArray(o.remove) ? o.remove.filter(isKey) : [],
    dll_override: str(o.dll_override, /^[A-Za-z0-9_]{1,32}$/),
    dxvk_config: str(o.dxvk_config, SAFE_VAL),
    args: words(o.args, SAFE_ARG),
  };
};

/** A stored ui_opti_log value, keeping only well-formed entries. */
export const readLog = (v: unknown): OptiLog => {
  const out: OptiLog = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d+$/.test(k) || !r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const plan = readPlan(o.plan);
    const pending = o.pending === true;
    if (!plan && !pending) continue;
    const dropped: Partial<Record<ManagedKey, string>> = {};
    if (o.dropped && typeof o.dropped === "object") {
      for (const [key, val] of Object.entries(o.dropped as Record<string, unknown>)) if (isKey(key) && typeof val === "string") dropped[key] = val;
    }
    out[k] = {
      plan, dropped,
      args: words(o.args, SAFE_ARG),
      lists: words(o.lists, /^(WINEDLLOVERRIDES|DXVK_CONFIG)$/),
      at: typeof o.at === "number" ? o.at : 0,
      pending, want: pending ? readPlan(o.want) : null,
    };
    if (typeof o.before === "string" && typeof o.after === "string" && o.before.length <= TEXT_MAX && o.after.length <= TEXT_MAX) {
      out[k].before = o.before;
      out[k].after = o.after;
    }
  }
  return out;
};

/** The log with the newest LOG_MAX games, then cut further until it fits `bytes`. */
export const fitLog = (log: OptiLog, bytes = 3800): OptiLog => {
  let entries = Object.entries(log ?? {}).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, LOG_MAX);
  while (entries.length > 1 && JSON.stringify(Object.fromEntries(entries)).length > bytes) entries = entries.slice(0, -1);
  return Object.fromEntries(entries);
};

// ---- choices, labels, checklist -----------------------------------------------------------------------------------

export const UPSCALERS: { data: OptiUpscaler; label: string }[] = [
  { data: "xess", label: "XeSS" }, { data: "fsr31", label: "FSR 3.1" },
];
export const FGS: { data: OptiFg; label: string }[] = [
  { data: 0, label: "Off" }, { data: 2, label: "XeFG 2x" }, { data: 3, label: "XeFG 3x" }, { data: 4, label: "XeFG 4x" },
];
export const INPUTS: { data: OptiFgInput; label: string }[] = [
  { data: "dlssg", label: "DLSS frame generation" },
  { data: "xefg", label: "XeSS frame generation" },
  { data: "upscaler", label: "None: OptiScaler makes its own" },
];
export const DEFAULT_CHOICES: OptiChoices = { upscaler: "xess", fg: 2, fg_input: "dlssg" };

/** The labels of a set of choices. */
export const choiceLabels = (c: OptiChoices) => ({
  upscaler: UPSCALERS.find((u) => u.data === c.upscaler)?.label ?? c.upscaler,
  fg: FGS.find((f) => f.data === c.fg)?.label ?? `${c.fg}x`,
  input: INPUTS.find((i) => i.data === c.fg_input)?.label ?? c.fg_input,
});

/** A stored or answered choices object, else null. */
export const readChoices = (v: unknown): OptiChoices | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const up = UPSCALERS.find((u) => u.data === o.upscaler)?.data;
  const fg = FGS.find((f) => f.data === o.fg)?.data;
  const input = INPUTS.find((i) => i.data === o.fg_input)?.data;
  return up !== undefined && fg !== undefined && input !== undefined ? { upscaler: up, fg, fg_input: input } : null;
};

/** The game's upscaling choice OptiScaler takes the place of, and its frame generation (for the checklist). */
const inGame = (input: OptiFgInput): { upscale: string; fg: string | null } =>
  input === "dlssg" ? { upscale: "DLSS", fg: "DLSS Frame Generation" }
    : input === "xefg" ? { upscale: "XeSS", fg: "XeSS Frame Generation" }
    : { upscale: "DLSS", fg: null };

/** The checklist's one line up front (≤ 80 characters). */
export const checklistLine = (input: OptiFgInput, fg: OptiFg): string => {
  const g = inGame(input);
  if (!fg || !g.fg) return `Pick ${g.upscale} in the game, then restart it once.`;
  return input === "dlssg" ? "Pick DLSS and DLSS frame generation, then restart the game."
    : "Pick XeSS and XeSS frame generation, then restart the game.";
};

/** The numbered steps in the checklist's Details (DESIGN.md "UI"). */
export const checklist = (input: OptiFgInput, fg: OptiFg): string[] => {
  const g = inGame(input);
  const steps = [
    "Start the game (it starts in DirectX 12).",
    "Graphics: Display mode Borderless (XeSS frame generation refuses exclusive fullscreen).",
    `Upscaling: ${g.upscale} (any quality).`,
  ];
  if (fg && g.fg) steps.push(`Frame Generation: ${g.fg} on.`);
  else if (fg) steps.push("Frame Generation: off in the game; OptiScaler makes the frames itself.");
  steps.push("Quit and start the game again, once.");
  steps.push(fg ? "Check: OptiScaler's menu (Insert on a keyboard) shows XeSS and FG Output XeFG."
    : "Check: OptiScaler's menu (Insert on a keyboard) shows the upscaler you picked.");
  return steps.map((t, i) => `${i + 1}. ${t}`);
};

/** What to do when the checklist does not work (the Details' last paragraph). */
export const CHECKLIST_HELP = [
  "If DLSS is greyed out in the game: pick \"XeSS frame generation\" as the game setting it replaces (Games tab) and XeSS in the game.",
  "If the picture flickers with DLSS: pick XeSS in the game (OptiScaler's wiki, Known Issues).",
];

/** The status row's line up front. */
export const statusLine = (info: OptiInfo | null | undefined): string => {
  if (!info) return "Checking…";
  if (info.state === "other") return "Another OptiScaler is installed";
  if (info.state === "partial") return "Partly removed: open Details";
  if (info.state === "none") return "Not installed";
  if (info.update) return "Update available";
  const c = info.choices;
  if (!c) return "Installed";
  const l = choiceLabels(c);
  return c.fg ? `${l.upscaler} · frame generation ${c.fg}x` : `${l.upscaler} · no frame generation`;
};

/** The warning rows: not refused, only shown (DESIGN.md "Refusals", last paragraph). */
export const optiWarnings = (game: GameInfo | null | undefined, xessInstalled: boolean | null | undefined): { label: string; line: string; detail: string }[] => {
  const out: { label: string; line: string; detail: string }[] = [];
  if (xessInstalled === false || game?.compat_tool_shimmed === false) {
    out.push({ label: "XeSS fast mode missing", line: "OptiScaler's XeSS will run in the slower mode.",
      detail: "OptiScaler's XeSS and XeSS frame generation reach the XMX cores through xess-xmx-linux's shim in the game's Proton. Without it (XeSS fast mode not installed, or this Proton lacks the shim) XeSS runs on the slower DP4a path. Install XeSS fast mode, or pick a Proton that has the shim." });
  }
  const tool = `${game?.compat_tool ?? game?.default_compat_tool ?? ""}`;
  if (game?.prefix_checks?.hides_wine || /cachyos/i.test(tool)) {
    out.push({ label: "Proton may not work with frame generation", line: "Use Proton Experimental or GE-Proton for this game.",
      detail: "CachyOS's Proton build hides Wine from games, and XeLL (which XeSS frame generation needs) may refuse the GPU there. Pick Proton Experimental or GE-Proton in the game's Properties → Compatibility." });
  }
  return out;
};

/** The warning rows from the backend's lines (OptiInfo.warnings) when it sends them, else from GameInfo. */
export const warningRows = (info: OptiInfo | null | undefined, game: GameInfo | null | undefined, xessInstalled: boolean | null | undefined) => {
  if (!Array.isArray(info?.warnings)) return optiWarnings(game, xessInstalled);
  const known = optiWarnings({ compat_tool_shimmed: false, compat_tool: "cachyos" } as GameInfo, false);
  return info.warnings.filter((w): w is string => typeof w === "string" && !!w)
    .map((w) => known.find((k) => k.line === w) ?? { label: "OptiScaler", line: w, detail: w });
};

export type OptiConfirm = { title: string; text: string[]; lines: string[]; linesTitle: string; ok: string; effect: EffectSpec; destructive?: boolean };
const GAME: EffectSpec = "game";

/** The install dialog (DESIGN.md "UI", Confirm row). */
export const confirmInstall = (info: OptiInfo | null | undefined, name: string, choices: OptiChoices): OptiConfirm => {
  const size = info?.cached ? "already downloaded" : info?.download_mb ? `about ${Math.round(info.download_mb)} MB` : "about 69 MB";
  const l = choiceLabels(choices);
  const d = readChoices(info?.defaults);
  const same = !!d && d.upscaler === choices.upscaler && d.fg === choices.fg && d.fg_input === choices.fg_input;
  const plan = info?.launch ?? (same ? info?.launch_new ?? null : null);
  const pl = planLines(plan);
  return {
    title: "Install OptiScaler?",
    text: [
      `${info?.cached ? "Puts OptiScaler" : `Downloads OptiScaler (${size}) and puts it`} in ${name}'s folder. Remove puts everything back.`,
      `It runs ${l.upscaler}${choices.fg ? ` and XeSS frame generation ${choices.fg}x` : ""} when the game asks for ${inGame(choices.fg_input).upscale}. Install stops if the folder already has a dxgi.dll or another OptiScaler; the game's own files are not touched.`,
      "The launch options change too: OXP3 Deck takes out the XeSS settings OptiScaler replaces and adds what it needs; Remove puts them back.",
      "OptiScaler is not part of OXP3 Deck: it is downloaded from its GitHub release (GPL-3.0).",
    ],
    lines: [
      ...(info?.folder ? [`Folder: ${info.folder}`] : []),
      ...(pl.adds.length ? [`Adds to launch options: ${pl.adds.join(" ")}`] : []),
      ...(pl.removes.length ? [`Removes: ${pl.removes.join(" ")}`] : [`Removes: ${OPTI_DROPPED.join(", ")} (when set)`]),
    ],
    linesTitle: "Technical:",
    ok: "Install", effect: GAME,
  };
};

/** The remove dialog. */
export const confirmRemove = (info: OptiInfo | null | undefined, name: string, entry: OptiLogEntry | null | undefined): OptiConfirm => {
  const pl = planLines(entry?.plan ?? info?.launch ?? null, entry?.dropped);
  return {
    title: "Remove OptiScaler?",
    text: [
      `Deletes OptiScaler's files from ${name}'s folder and puts the game's own files back.`,
      "A file that changed since the install is kept, and Details say where. The launch options get back what OptiScaler replaced.",
    ],
    lines: [
      ...(info?.folder ? [`Folder: ${info.folder}`] : []),
      ...(pl.adds.length ? [`Takes out of launch options: ${pl.adds.join(" ")}`] : []),
      ...(entry && pl.removes.length ? [`Puts back: ${pl.removes.join(" ")}`] : []),
    ],
    linesTitle: "Technical:",
    ok: "Remove", effect: GAME, destructive: true,
  };
};

/** The toast after the launch options were written for a new install. */
export const readyToast = (name: string, input: OptiFgInput, fg: OptiFg): string => {
  const g = inGame(input);
  return fg && g.fg ? `OptiScaler ready for ${name}: pick ${g.upscale} and ${g.fg.replace("Frame Generation", "frame generation")} in the game.`
    : `OptiScaler ready for ${name}: pick ${g.upscale} in the game.`;
};
