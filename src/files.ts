// Damaged or newer settings files (ROADMAP T1-5): the rows the Status section shows for the overview's `files`.
// Framework-free so node can test it (tests/js/files.test.mjs).
import type { FileProblem } from "./types";

/** What each settings file holds, in plain words. */
const NAMES: Record<string, string> = {
  "auto.json": "Automatic setup",
  "optiscaler.json": "OptiScaler",
  "settings.json": "Settings",
  "power.json": "Power settings",
  "extras.json": "Fan & battery settings",
  "advisor.json": "Power tips",
  "selftest.json": "Self-test results",
};

export const fileName = (file: string): string => NAMES[file] ?? file;

export type FileRow = {
  label: string;
  line: string;
  button: string;                                   // "Start fresh" or "OK"
  ask: { title: string; text: string; ok: string } | null;   // a confirmation before the button's action
  details: { title: string; body: string[]; lines: string[] };
};

const LOST: Record<string, string> = {
  "auto.json": "Changes made earlier stay in the games, but OXP3 Deck no longer lists them or can undo them.",
  "optiscaler.json": "OptiScaler stays in the games it was installed in; OXP3 Deck then treats it as another tool's.",
};

/** The row for one problem: a damaged or newer file waits for Start fresh; another file already started empty. */
export const fileRow = (p: FileProblem): FileRow => {
  const name = fileName(p.file);
  const tech = [`file: ${p.file}`, ...(p.copy ? [`copy: ${p.copy}`] : []),
    ...(p.kind === "newer" && p.version != null ? [`version: ${p.version}`] : [])];
  if (p.kind === "newer") {
    return {
      label: "Settings are from a newer OXP3 Deck",
      line: `${name} is read-only here. Update OXP3 Deck.`,
      button: "Start fresh",
      ask: { title: "Start fresh?", ok: "Start fresh",
        text: `${name} was saved by a newer OXP3 Deck. Starting fresh sets that file aside and starts empty. ${LOST[p.file] ?? ""}`.trim() },
      details: { title: "Settings are from a newer OXP3 Deck", lines: tech, body: [
        `${name} was saved by a newer OXP3 Deck. This version shows it but does not change it, so nothing is lost.`,
        "Update OXP3 Deck to use it again. Start fresh sets the file aside and starts empty.",
      ] },
    };
  }
  if (p.kind === "damaged") {
    return {
      label: `${name}: file damaged`,
      line: "Saving is paused. A copy is kept.",
      button: "Start fresh",
      ask: { title: "Start fresh?", ok: "Start fresh",
        text: `${name} starts empty and saving works again. ${LOST[p.file] ?? ""}`.trim() },
      details: { title: `${name}: file damaged`, lines: tech, body: [
        `OXP3 Deck could not read its ${name} file, for example after the battery ran out while it was saving.`,
        "The file is kept as a copy, and nothing is saved until you tap Start fresh.",
        LOST[p.file] ?? "",
      ].filter(Boolean) },
    };
  }
  return {
    label: `${name}: file was damaged`,
    line: "It started empty. A copy is kept.",
    button: "OK",
    ask: null,
    details: { title: `${name}: file was damaged`, lines: tech, body: [
      `OXP3 Deck could not read its ${name} file, so those settings started empty. Set them again.`,
      "The damaged file is kept as a copy.",
    ] },
  };
};
