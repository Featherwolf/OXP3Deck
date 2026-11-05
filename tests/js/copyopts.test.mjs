// Tests for src/copyopts.ts and src/clipboard.ts. Run from the repository root:
// node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const { copyDetails, copyLine, copyRow } = await import("../../src/copyopts.ts");
const { clipboardMethods, copyWith, execCopy, navigatorCopy } = await import("../../src/clipboard.ts");
const { EFFECTS, effectText } = await import("../../src/effects.ts");

const XESS = { key: "XESS", value: "latest", why: "old XeSS" };
const FSR = { key: "FSR", value: "xess", why: "FSR 3.1" };
const base = { steam: true, text: "", draft: "", wanted: null };

test("copyLine: nothing while reading or when the line would be empty", () => {
  assert.equal(copyLine({ ...base, text: undefined }), null);
  assert.equal(copyLine({ ...base, text: "" }), null);
  assert.equal(copyLine({ ...base, steam: false, text: null, draft: "" }), null);
});

test("copyLine: the user's own text is kept, the missing managed keys are set with setManaged", () => {
  const user = "PROTON_LOG=1 gamemoderun %command% -dx11";
  assert.deepEqual(copyLine({ ...base, text: user }), { line: user, reason: "current", adds: "" });
  const c = copyLine({ ...base, text: user, suggest: [XESS, FSR] });
  assert.deepEqual(c, { line: "PROTON_LOG=1 XESS=latest FSR=xess gamemoderun %command% -dx11", reason: "advice", adds: "XESS=latest FSR=xess" });
  // set already (any value) or removed after an automatic addition: not again
  assert.equal(copyLine({ ...base, text: "XESS=dp4a %command%", suggest: [XESS] }).line, "XESS=dp4a %command%");
  assert.equal(copyLine({ ...base, text: "%command%", suggest: [XESS], done: ["XESS"] }).reason, "current");
  // empty text with advice: just the keys and %command%
  assert.deepEqual(copyLine({ ...base, text: "", suggest: [XESS] }), { line: "XESS=latest %command%", reason: "advice", adds: "XESS=latest" });
  // game arguments without %command% go behind it (setManaged's quoting)
  assert.equal(copyLine({ ...base, text: "-novid", suggest: [XESS] }).line, "XESS=latest %command% -novid");
  // a %command typo is left as it is
  assert.deepEqual(copyLine({ ...base, text: "XESS=latest %command", suggest: [FSR] }), { line: "XESS=latest %command", reason: "current", adds: "" });
  // a value that would need quoting, an unknown key: skipped
  assert.equal(copyLine({ ...base, text: "%command%", suggest: [{ key: "XESS", value: "a b" }, { key: "PATH", value: "x" }] }).reason, "current");
});

test("copyLine: why the row is there", () => {
  // the automatic launch options wait for the game to quit
  assert.equal(copyLine({ ...base, text: "%command%", suggest: [XESS], autoOn: true, running: true }).reason, "running");
  assert.equal(copyLine({ ...base, text: "%command%", suggest: [XESS], autoOn: false, running: true }).reason, "advice");
  // automatic mode refuses game arguments that would need quoting without %command%: no "added when you quit"
  for (const text of ['-novid "Player One"', "-x $HOME"]) {
    const c = copyLine({ ...base, text, suggest: [XESS], autoOn: true, running: true });
    assert.equal(c.reason, "advice", text);
    assert.match(c.line, /^XESS=latest %command% /);
  }
  assert.equal(copyLine({ ...base, text: "-novid", suggest: [XESS], autoOn: true, running: true }).reason, "running");
  // Steam refused (or kept other text after) a write: the line it tried, with what the game needs
  const r = copyLine({ ...base, text: "A=1 %command%", wanted: "A=1 MESA=26.3 %command%", suggest: [XESS] });
  assert.deepEqual(r, { line: "A=1 MESA=26.3 XESS=latest %command%", reason: "rejected", adds: "XESS=latest" });
  assert.equal(copyLine({ ...base, text: undefined, wanted: "MESA=26.3 %command%" }).reason, "rejected");
  // a write that Steam did keep after all is not "rejected"
  assert.equal(copyLine({ ...base, text: "MESA=26.3 %command%", wanted: "MESA=26.3 %command%" }).reason, "current");
  // a non-Steam shortcut and unreadable options: the draft picked here
  assert.deepEqual(copyLine({ ...base, steam: false, text: null, draft: "XESS_FG=3 %command%" }),
    { line: "XESS_FG=3 %command%", reason: "shortcut", adds: "" });
  assert.deepEqual(copyLine({ ...base, text: null, draft: "", suggest: [FSR] }), { line: "FSR=xess %command%", reason: "unreadable", adds: "FSR=xess" });
});

test("copyRow and copyDetails: one short line; Details say where to paste and when it applies", () => {
  for (const reason of ["rejected", "shortcut", "unreadable", "running", "advice", "current"]) {
    const c = { line: "XESS=latest %command%", reason, adds: "" };
    const r = copyRow(c);
    assert.equal(r.label, "Copy launch options");
    assert.ok(r.line.length <= 60, r.line);
    assert.doesNotMatch(r.line, /XESS|%command%/, "no variable names up front");
    const d = copyDetails(c, "Cyberpunk 2077").join(" ");
    assert.match(d, /Cyberpunk 2077's Properties .*Launch options/);
    assert.match(d, /Takes effect: Restart the game\./);
  }
  assert.equal(EFFECTS["game.copy"], "game");
  assert.equal(effectText(EFFECTS["game.copy"]), "Restart the game");
});

const fakeDoc = ({ exec = true, clip } = {}) => {
  const log = [];
  const body = { kids: [], appendChild(e) { this.kids.push(e); }, removeChild(e) { this.kids = this.kids.filter((k) => k !== e); } };
  const prev = { focus() { log.push("refocus"); } };
  const doc = {
    body, activeElement: prev, log,
    createElement: () => ({ style: {}, setAttribute() {}, focus() { log.push("focus"); }, select() { log.push("select"); }, setSelectionRange() {} }),
    execCommand: (cmd) => { log.push(`exec:${cmd}:${body.kids[0]?.value}`); if (exec === "throw") throw new Error("no"); return exec; },
    defaultView: clip ? { navigator: { clipboard: clip } } : null,
  };
  return doc;
};

test("execCopy: hidden textarea, copy, cleaned up, focus given back", () => {
  const d = fakeDoc();
  assert.equal(execCopy(d, "XESS=latest %command%"), true);
  assert.deepEqual(d.log, ["focus", "select", "exec:copy:XESS=latest %command%", "refocus"]);
  assert.equal(d.body.kids.length, 0);
  assert.equal(execCopy(fakeDoc({ exec: false }), "x"), false);
  assert.equal(execCopy(fakeDoc({ exec: "throw" }), "x"), false);
  assert.equal(execCopy(null, "x"), false);
  assert.equal(execCopy({ createElement() {}, body: {} }, "x"), false);   // no execCommand
});

test("copyWith: the first method that works; throws, false and hangs fall through", async () => {
  const calls = [];
  const m = (name, run) => ({ name, run: (t) => { calls.push(name); return run(t); } });
  const got = await copyWith("x", [
    m("throws", () => { throw new Error("no"); }),
    m("rejects", () => Promise.reject(new Error("no"))),
    m("false", () => false),
    m("hangs", () => new Promise(() => {})),
    m("ok", () => Promise.resolve(true)),
    m("never", () => true),
  ], 20);
  assert.equal(got, "ok");
  assert.deepEqual(calls, ["throws", "rejects", "false", "hangs", "ok"]);
  assert.equal(await copyWith("x", [m("no", () => false)], 20), null);
  assert.equal(await copyWith("x", [], 20), null);
});

test("clipboardMethods: execCommand first, then navigator.clipboard of the same document", async () => {
  let written = null;
  const d = fakeDoc({ exec: false, clip: { writeText: async (t) => { written = t; } } });
  const ms = clipboardMethods(d);
  assert.deepEqual(ms.map((x) => x.name).slice(0, 2), ["execCommand", "navigator.clipboard"]);
  assert.equal(await copyWith("FSR=xess %command%", ms, 50), "navigator.clipboard");
  assert.equal(written, "FSR=xess %command%");
  assert.equal(await navigatorCopy(fakeDoc(), "x"), false);
  const bad = fakeDoc({ exec: false, clip: { writeText: async () => { throw new Error("not focused"); } } });
  assert.equal(await copyWith("x", clipboardMethods(bad), 50), null);
});

test("GameControls shows the copy row; it has the effect tag and the text field fallback", () => {
  const src = (n) => readFileSync(new URL(`../../src/${n}`, import.meta.url), "utf8");
  assert.match(src("components/GameControls.tsx"), /<CopyLaunchRows input=\{copyInput\} game=\{app\.name\} \/>/);
  assert.match(src("components/GameControls.tsx"), /setWanted\(r\.ok \? null : next\);/);
  const c = src("components/CopyLaunch.tsx");
  assert.match(c, /EFFECTS\["game\.copy"\]/);
  assert.match(c, /toast\([^)]*"Copied"\)/);
  assert.match(c, /<TextField [^>]*value=\{manual\}/);
  assert.doesNotMatch(c, /setLaunchOptions/, "copying never writes");
});
