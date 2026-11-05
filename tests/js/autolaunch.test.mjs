// Tests for src/autolaunch.ts. Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./tsresolve.mjs";

const {
  choiceOf, effectiveOn, fitLog, plan, readLog, readSettings, record, trimLog, undo, undone, withChoice,
} = await import("../../src/autolaunch.ts");

const XESS = { key: "XESS", value: "latest", why: "XeSS 1.3.1 is older than 2.0.2.68, so it would run in the slower mode." };
const FSR = { key: "FSR", value: "xess", why: "The game has FSR 3.1+ and no XeSS: its FSR runs on XeSS." };

test("plan adds absent keys only, keeping the user's text byte for byte", () => {
  assert.deepEqual(plan("", [XESS], undefined), { text: "XESS=latest %command%", added: [XESS] });
  const user = "PROTON_LOG=1   gamemoderun  %command%  -dx11 'a  b'";
  const p = plan(user, [XESS, FSR], undefined);
  assert.equal(p.text, "PROTON_LOG=1   XESS=latest FSR=xess gamemoderun  %command%  -dx11 'a  b'");
  assert.deepEqual(p.added.map((a) => a.key), ["XESS", "FSR"]);
  assert.equal(p.text.replace("XESS=latest FSR=xess ", ""), user);
  // only assignments before %command%: in front of %command%
  assert.equal(plan("A=1  %command%", [XESS], undefined).text, "A=1  XESS=latest %command%");
  assert.equal(plan("%command% -novid", [FSR], undefined).text, "FSR=xess %command% -novid");
  // set already (any value, also an unmanaged copy of the name): nothing
  assert.deepEqual(plan("XESS=dp4a %command%", [XESS], undefined).added, []);
  assert.equal(plan("XESS=dp4a %command%", [XESS], undefined).text, "XESS=dp4a %command%");
  // game arguments without %command%: only when they need no re-quoting
  assert.equal(plan("-dx11 -novid", [XESS], undefined).text, "XESS=latest %command% -dx11 -novid");
  assert.deepEqual(plan("-name \"Player One\"", [XESS], undefined).added, []);
  // twice the same key, an unknown key, a value that needs quoting
  assert.deepEqual(plan("", [XESS, XESS], undefined).added, [XESS]);
  assert.deepEqual(plan("", [{ key: "LD_PRELOAD", value: "x", why: "" }], undefined).added, []);
  assert.deepEqual(plan("", [{ key: "XESS", value: "a b", why: "" }], undefined).added, []);
});

test("plan skips keys done before and does nothing on a typo", () => {
  const rec = record(undefined, [XESS], 100);
  assert.deepEqual(plan("%command%", [XESS, FSR], rec).added, [FSR]);
  const gone = undone(rec, 200);
  assert.deepEqual(plan("", [XESS], gone).added, []);
  assert.deepEqual(plan("XESS=latest %command", [FSR], undefined), { text: "XESS=latest %command", added: [] });
});

test("undo removes only the added keys whose value is unchanged", () => {
  const rec = record(undefined, [XESS, FSR], 100);
  assert.equal(undo("PROTON_LOG=1   XESS=latest FSR=xess gamemoderun  %command%  -dx11", rec), "PROTON_LOG=1   gamemoderun  %command%  -dx11");
  assert.equal(undo("XESS=latest %command%", rec), "");
  assert.equal(undo("XESS=dp4a FSR=xess %command% -x", rec), "XESS=dp4a %command% -x");
  assert.equal(undo("no command here", rec), "no command here");
  // round trip
  const user = "A=1 %command% -b";
  assert.equal(undo(plan(user, [XESS], undefined).text, record(undefined, [XESS], 1)), user);
});

test("record and undone", () => {
  const a = record(undefined, [XESS], 100);
  assert.deepEqual(a, { added: { XESS: "latest" }, why: [XESS.why], at: 100, done: ["XESS"], undone: false });
  const b = record(a, [FSR], 200);
  assert.deepEqual(b.added, { XESS: "latest", FSR: "xess" });
  assert.deepEqual(b.done, ["XESS", "FSR"]);
  assert.equal(record(b, [], 300), b);
  const u = undone(b, 400);
  assert.equal(u.undone, true);
  assert.deepEqual(u.done, ["XESS", "FSR"]);
  assert.deepEqual(record(u, [{ key: "XESS_LOG", value: "1", why: "w" }], 500).added, { XESS_LOG: "1" });
});

test("trimLog keeps the 20 newest, fitLog stays under the setting's size", () => {
  const log = {};
  for (let i = 0; i < 30; i++) log[String(1000 + i)] = record(undefined, [XESS], i);
  const t = trimLog(log);
  assert.equal(Object.keys(t).length, 20);
  assert.ok(!("1000" in t) && "1029" in t && "1010" in t && !("1009" in t));
  assert.equal(Object.keys(trimLog(log, 5)).length, 5);
  const f = fitLog(log, 1000);
  assert.ok(JSON.stringify(f).length <= 1000);
  assert.ok("1029" in f);
});

test("effectiveOn, the per-game choice and reading stored values", () => {
  assert.equal(effectiveOn(null, "1"), false);
  assert.equal(effectiveOn({ on: true, games: {} }, "1"), true);
  assert.equal(effectiveOn({ on: true, games: { 1: false } }, "1"), false);
  assert.equal(effectiveOn({ on: false, games: { 1: true } }, "1"), true);
  assert.equal(choiceOf({ on: false, games: { 1: true } }, "1"), "on");
  assert.equal(choiceOf(null, "1"), "global");
  assert.deepEqual(withChoice({ on: true, games: { 1: true } }, "1", "global"), { on: true, games: {} });
  assert.deepEqual(withChoice(null, "7", "off"), { on: false, games: { 7: false } });
  assert.deepEqual(readSettings({ on: true, games: { 1: true, x: true, 2: "yes" } }), { on: true, games: { 1: true } });
  assert.deepEqual(readSettings("junk"), { on: false, games: {} });
  const rl = readLog({ 5: { added: { XESS: "latest", EVIL: "x" }, why: ["w", 3], at: 9, done: ["XESS", "NOPE"], undone: false }, bad: {} });
  assert.deepEqual(rl, { 5: { added: { XESS: "latest" }, why: ["w"], at: 9, done: ["XESS"], undone: false } });
});
