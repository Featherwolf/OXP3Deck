// Tests for src/xesslog.ts (Save XeSS logs for one run, ROADMAP T1-12 / C-7) and its wiring. Run from the repository
// root: node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const {
  exitStep, kept, logOn, logView, LOG_MAX, needsLogTime, NOTE_MIN_S, offToast, ON_LINE, KEPT_LINE, OFF_LABEL, readState,
  toggled, trimState, withoutLog,
} = await import("../../src/xesslog.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const ID = "292030";

test("logOn and withoutLog: only XESS_LOG goes, the user's text stays", () => {
  assert.equal(logOn("XESS_LOG=1 %command%"), true);
  assert.equal(logOn("XESS_LOG=2 %command%"), true);
  assert.equal(logOn("XESS_LOG=0 %command%"), false);
  assert.equal(logOn("%command% XESS_LOG=1"), false);   // a game argument, not a variable
  assert.equal(logOn(null), false);
  assert.equal(withoutLog("PROTON_LOG=1 XESS_LOG=1 gamemoderun %command% -dx12"), "PROTON_LOG=1 gamemoderun %command% -dx12");
  assert.equal(withoutLog("XESS_LOG=1 %command%"), "");   // nothing left: Steam's empty launch options
});

test("a fresh log after the game quit turns logging off, once, and the note starts", () => {
  const s = toggled({}, ID, true, 1000);
  assert.deepEqual(s, { [ID]: { on_at: 1000 } });
  const text = "XESS=latest XESS_LOG=1 %command%";
  assert.equal(needsLogTime(s, ID, text), true);
  const step = exitStep(s, ID, text, 1500, 1600);
  assert.equal(step.do, "off");
  assert.equal(step.text, "XESS=latest %command%");
  assert.deepEqual(step.state[ID], { on_at: 1000, off_at: 1600 });
  assert.deepEqual(logView(step.state, ID, step.text), { on: false, keep: false, turnedOff: true });
  // the same exit seen again (lifetime event + main app change): the note stays
  assert.deepEqual(exitStep(step.state, ID, step.text, 1500, 1610), { do: "nothing" });
  assert.equal(needsLogTime(step.state, ID, step.text), false);
  // the next run's exit ends the note
  const end = exitStep(step.state, ID, step.text, 1500, 1600 + NOTE_MIN_S + 600);
  assert.equal(end.do, "note");
  assert.deepEqual(end.state, {});
});

test("no fresh log, kept on, no record, unreadable options: logging stays on", () => {
  const text = "XESS_LOG=1 %command%";
  const s = toggled({}, ID, true, 1000);
  // a log from before logging was turned on, or none (the game did not use XeSS, a Proton without the hook)
  assert.deepEqual(exitStep(s, ID, text, 900, 2000), { do: "nothing" });
  assert.deepEqual(exitStep(s, ID, text, 1000, 2000), { do: "nothing" });
  assert.deepEqual(exitStep(s, ID, text, null, 2000), { do: "nothing" });
  // Keep logging on
  const k = kept(s, ID, 1100);
  assert.deepEqual(k[ID], { on_at: 1100, keep: true });
  assert.equal(needsLogTime(k, ID, text), false);
  assert.deepEqual(exitStep(k, ID, text, 5000, 6000), { do: "nothing" });
  assert.deepEqual(logView(k, ID, text), { on: true, keep: true, turnedOff: false });
  // set by hand (no record): the record starts now, the next run decides
  const first = exitStep({}, ID, text, 5000, 6000);
  assert.equal(first.do, "note");
  assert.deepEqual(first.state[ID], { on_at: 6000 });
  assert.equal(exitStep(first.state, ID, text, 7000, 7100).do, "off");
  // put back by hand after a turn-off: a new record, not an immediate turn-off
  const again = exitStep({ [ID]: { on_at: 1, off_at: 2 } }, ID, text, 5000, 6000);
  assert.deepEqual(again, { do: "note", state: { [ID]: { on_at: 6000 } } });
  // Steam did not return the options: nothing
  assert.deepEqual(exitStep(s, ID, null, 5000, 6000), { do: "nothing" });
  // off and no record: nothing to store
  assert.deepEqual(exitStep({}, ID, "%command%", 5000, 6000), { do: "nothing" });
});

test("the toggle: on starts afresh (an old keep or note goes), off drops the record", () => {
  const s = { [ID]: { on_at: 5, keep: true }, "10": { on_at: 1, off_at: 2 } };
  assert.deepEqual(toggled(s, ID, false, 9), { "10": { on_at: 1, off_at: 2 } });
  assert.deepEqual(toggled(s, "10", true, 9)["10"], { on_at: 9 });
  assert.deepEqual(logView(undefined, ID, "XESS_LOG=1 %command%"), { on: true, keep: false, turnedOff: false });
});

test("readState keeps well-formed records only; trimState keeps the newest games", () => {
  assert.deepEqual(readState(null), {});
  assert.deepEqual(readState({ [ID]: { on_at: 3, keep: true, off_at: 4, x: 1 }, abc: { on_at: 1 }, "7": "no", "8": { on_at: "x", keep: 1 } }),
    { [ID]: { on_at: 3, keep: true, off_at: 4 }, "8": { on_at: 0 } });
  const many = Object.fromEntries(Array.from({ length: LOG_MAX + 5 }, (_, i) => [String(i + 1), { on_at: i }]));
  const t = trimState(many);
  assert.equal(Object.keys(t).length, LOG_MAX);
  assert.ok(!("1" in t) && String(LOG_MAX + 5) in t);
  assert.ok(JSON.stringify(t).length < 4096);
});

test("short user-visible text", () => {
  for (const line of [ON_LINE, KEPT_LINE, OFF_LABEL, offToast("The Witcher 3: Wild Hunt")]) assert.ok(line.length <= 80, line);
  assert.equal(ON_LINE, "Logging on: costs performance.");
  assert.equal(OFF_LABEL, "Logging turned off after one run");
});

test("wiring: the exit flow runs the turn-off; it writes only after an isRunning check; the toggle records it", () => {
  const a = src("components/AutoSetup.tsx");
  const flow = a.slice(a.indexOf("export const exitFlow"), a.indexOf("export const AUTO_AFTER_EXIT_MS"));
  const opti = flow.indexOf("await optiApplyPending(appid, name)"), log = flow.indexOf("await xessLogAfterExit(appid, name)");
  assert.ok(opti > 0 && log > opti && log < flow.indexOf("await sessions.get(appid)"), "after OptiScaler's options, before the pass");
  const x = src("components/XessLog.tsx");
  const fn = x.slice(x.indexOf("const afterExit = async"));
  const w = fn.indexOf("await setLaunchOptions(appid, step.text)");
  assert.ok(w > 0 && fn.lastIndexOf("if (isRunning(appid)) return;", w) > 0, "isRunning right before the write");
  const reread = fn.lastIndexOf("if (await getLaunchOptions(appid) !== text) return;", w);
  assert.ok(reread > fn.indexOf("const step = exitStep("), "the launch options are read again after the awaits, before the write");
  assert.doesNotMatch(x, /markManual/, "the plugin's own turn-off does not make the game Manual");
  const g = src("components/GameControls.tsx");
  assert.match(g, /onChange=\{\(v\) => \{ void toggleLog\(v\); \}\}/);
  assert.match(g, /await noteLogToggle\(app\.appid, v\);/);
  assert.match(g, /lv\.on \? \(lv\.keep \? KEPT_LINE : ON_LINE\)/);
  assert.match(g, /Keep logging on\n/);
  assert.match(g, /\{quick && lv\.on && <Status /);
});
