// "Copy launch options" (DESIGN.md "Copy launch options"): the whole launch line to paste by hand when OXP3 Deck
// cannot write it itself, and the row's texts. Pure, so node can test it (tests/js/copyopts.test.mjs). The line is
// the user's own text with the managed keys set through launchopts.setManaged, never a rewrite of the rest.
import { autoArgs, plan, planned } from "./autolaunch";
import { managed, type ManagedKey, MANAGED_KEYS, NEVER_AUTO, parse, setArg, setManaged } from "./launchopts";

export type CopySuggest = { key: ManagedKey; value: string; why?: string };

/**
 * Why the row is there: Steam refused (or kept other text after) a write; a non-Steam shortcut; Steam did not return
 * the launch options; what the game needs waits for it to quit (automatic on); what the game needs is not set
 * (automatic off, or it could not add it); or nothing is wrong and the user may still want a copy.
 */
export type CopyReason = "rejected" | "shortcut" | "unreadable" | "running" | "advice" | "current";

export type CopyInput = {
  steam: boolean;                     // a Steam game (isSteamApp)
  text: string | null | undefined;    // Steam's launch options now; undefined: still reading; null: unreadable
  draft: string;                      // what the user picked here while OXP3 Deck could not write (shortcut, unreadable)
  wanted: string | null;              // the last write Steam refused or changed (null: none)
  suggest?: CopySuggest[];            // GameInfo.suggest: what the game needs
  done?: ManagedKey[];                // keys added once by the automatic launch options (removed since: not again)
  autoOn?: boolean;                   // the automatic launch options act for this game
  running?: boolean;                  // the game runs now
  appid?: string;                     // for the game's DirectX 12 argument (launchopts DX12_ARGS) with frame generation
  argsDone?: string[];                // arguments added once by the automatic launch options (removed since: not again)
};

export type CopyLine = { line: string; reason: CopyReason; adds: string };

const SAFE = /^[A-Za-z0-9._-]{1,32}$/;

/** The suggested keys that `text` does not set yet (any value, also an unmanaged copy, counts as set). */
const missing = (text: string, suggest: CopySuggest[], done: ManagedKey[]): CopySuggest[] => {
  const p = parse(text);
  if (p.typo) return [];
  const have = managed(p);
  const seen = new Set<string>();
  return suggest.filter((a) => {
    if (!a || !(MANAGED_KEYS as readonly string[]).includes(a.key) || !SAFE.test(a.value ?? "")) return false;
    if (NEVER_AUTO.includes(a.key)) return false;       // never frame generation (it can crash a game)
    if (have[a.key] !== undefined || p.vars.some(([k]) => k === a.key) || done.includes(a.key) || seen.has(a.key)) return false;
    seen.add(a.key);
    return true;
  });
};

/**
 * The line to copy and why, or null when there is nothing to copy (still reading, or the line would be empty).
 * The base is the refused write, else the draft (shortcut, unreadable), else Steam's text; the keys the game needs
 * and lacks are then set with setManaged (a "%command" typo is left as it is: setManaged does not touch it).
 */
export const copyLine = (i: CopyInput): CopyLine | null => {
  if (i.steam && i.text === undefined && i.wanted === null) return null;
  let base: string;
  let reason: CopyReason;
  if (i.wanted !== null && i.wanted !== i.text) { base = i.wanted; reason = "rejected"; }
  else if (!i.steam) { base = i.draft; reason = "shortcut"; }
  else if (i.text === null || i.text === undefined) { base = i.draft; reason = "unreadable"; }
  else { base = i.text; reason = "current"; }
  const add = missing(base, i.suggest ?? [], i.done ?? []);
  const keyed = add.length ? setManaged(base, Object.fromEntries(add.map((a) => [a.key, a.value]))) : base;
  // the game's DirectX 12 argument after %command% when frame generation is set (autolaunch.autoArgs), not on a typo
  const args = parse(base).typo ? [] : autoArgs(i.appid ?? "", keyed).filter((a) => !(i.argsDone ?? []).includes(a.arg));
  let line = keyed;
  for (const a of args) line = setArg(line, a.arg, true);
  const adds = line === base ? "" : [...(keyed === base ? [] : add.map((a) => `${a.key}=${a.value}`)), ...(line === keyed ? [] : args.map((a) => a.arg))].join(" ");
  // "running" only when the automatic launch options would really add it after the game quits: plan() refuses
  // game arguments without %command% that would need quoting. The record is not needed: `add` already left out `done`.
  if (adds && reason === "current")
    reason = i.autoOn && i.running && planned(plan(base, add.map((a) => ({ ...a, why: a.why ?? "" })), undefined, args)) ? "running" : "advice";
  if (!line.trim()) return null;
  return { line, reason, adds };
};

/** The row's label and one line up front (≤ 60 characters). */
export const copyRow = (c: CopyLine): { label: string; line: string } => {
  switch (c.reason) {
    case "rejected": return { label: "Copy launch options", line: "Steam didn't take them. Paste them by hand." };
    case "shortcut": return { label: "Copy launch options", line: "OXP3 Deck can't write them for this game." };
    case "unreadable": return { label: "Copy launch options", line: "Steam didn't return them. Paste them by hand." };
    case "running": return { label: "Copy launch options", line: "Or wait: added when you quit the game." };
    case "advice": return { label: "Copy launch options", line: "Includes what this game needs." };
    default: return { label: "Copy launch options", line: "To paste them by hand." };
  }
};

const WHY: Record<CopyReason, string> = {
  rejected: "Steam did not keep the launch options OXP3 Deck wrote, so this is the line it tried to save.",
  shortcut: "OXP3 Deck does not change a non-Steam game's launch options.",
  unreadable: "Steam did not return this game's launch options, so OXP3 Deck does not write them (that would replace yours). This line has only what you picked here.",
  running: "The automatic launch options add what this game needs only after it has quit. This line has it already.",
  advice: "This line adds what this game needs for XeSS fast mode (and, for a game that needs it with frame generation, its DirectX 12 argument); the rest is your own text.",
  current: "These are the game's launch options as Steam has them.",
};

/** The Details body, in DESIGN order: what it does and why, where to paste it, when it takes effect. */
export const copyDetails = (c: CopyLine, game: string): string[] => [
  `Copies the whole launch line. ${WHY[c.reason]}`,
  `To use it: open ${game}'s Properties (the gear on its page) → General → Launch options, replace what is there with this line, then start the game again.`,
  "Takes effect: Restart the game.",
  "If copying does not work, the line shows in a text field: select it and copy it with Steam's keyboard.",
];
