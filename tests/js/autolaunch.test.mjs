// Tests for src/autolaunch.ts. Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const {
  choiceOf, effectiveOn, fitLog, plan, readLog, readSettings, record, trimLog, undo, undone, withChoice,
} = await import("../../src/autolaunch.ts");

const XESS = { key: "XESS", value: "latest", why: "XeSS 1.3.1 is older than 2.0.2.68, so it would run in the slower mode." };
const FSR = { key: "FSR", value: "xess", why: "The game has FSR 3.1+ and no XeSS: its FSR runs on XeSS." };

test("plan adds absent keys only, keeping the user's text byte for byte", () => {
  assert.deepEqual(plan("", [XESS], undefined), { text: "XESS=latest %command%", added: [XESS], args: [] });
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
  assert.deepEqual(plan("XESS=latest %command", [FSR], undefined), { text: "XESS=latest %command", added: [], args: [] });
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

test("plan never adds frame generation, whatever the backend suggests (MH Wilds crashed with XESS_FG)", () => {
  const fg = { key: "XESS_FG", value: "2", why: "x" };
  const fsrFg = { key: "FSR_FG", value: "xess", why: "x" };
  assert.deepEqual(plan("", [fg, fsrFg], undefined), { text: "", added: [], args: [] });
  const p = plan("%command%", [fg, XESS, fsrFg], undefined);
  assert.equal(p.text, "XESS=latest %command%");
  assert.deepEqual(p.added.map((a) => a.key), ["XESS"]);
});

test("the DirectX 12 argument: added for a known game with frame generation set, recorded, undone", async () => {
  const { autoArgs, DX12_WHY, hasAdded, recordText, planned, addedToast } = await import("../../src/autolaunch.ts");
  const W3 = "292030";
  assert.deepEqual(autoArgs(W3, "XESS_FG=3 %command% --launcher-skip"), [{ arg: "-dx12", why: DX12_WHY }]);
  assert.deepEqual(autoArgs(W3, "XESS=latest %command%"), [], "no frame generation set: nothing");
  assert.deepEqual(autoArgs(W3, "XESS_FG=3 %command% -dx12"), [], "already there");
  assert.deepEqual(autoArgs("10", "XESS_FG=3 %command%"), [], "a game not in the table: only the manual toggle");
  const user = "XESS_FG=3 %command%  --launcher-skip";
  const p = plan(user, [XESS], undefined, autoArgs(W3, user));
  assert.equal(p.text, "XESS_FG=3 XESS=latest %command%  --launcher-skip -dx12");
  assert.equal(planned(p), true);
  assert.deepEqual(p.args.map((a) => a.arg), ["-dx12"]);
  assert.equal(addedToast("The Witcher 3", p.added, p.args), "Added launch options for The Witcher 3: XESS=latest -dx12. They apply at its next start.");
  const rec = record(undefined, p.added, 100, p.args);
  assert.deepEqual(rec.args, ["-dx12"]);
  assert.deepEqual(rec.argsDone, ["-dx12"]);
  assert.equal(recordText(rec), "XESS=latest -dx12");
  assert.ok(hasAdded(rec));
  assert.equal(undo(p.text, rec), user);
  // once added (or undone) never again
  assert.deepEqual(plan(user, [], rec, autoArgs(W3, user)).args, []);
  assert.deepEqual(plan(user, [], undone(rec, 200), autoArgs(W3, user)).args, []);
  // an argument only (no key): the text is appended to, nothing else changes
  const q = plan(user, [], undefined, autoArgs(W3, user));
  assert.equal(q.text, `${user} -dx12`);
  const r2 = record(undefined, q.added, 100, q.args);
  assert.ok(hasAdded(r2));
  assert.equal(undo(q.text, r2), user);
  // a pipe after the game's arguments: the argument goes before it (not to tee), and Undo gives the text back
  const piped = "XESS_FG=3 %command% --launcher-skip 2>&1 | tee /tmp/w3.log";
  const pp = plan(piped, [], undefined, autoArgs(W3, piped));
  assert.equal(pp.text, "XESS_FG=3 %command% --launcher-skip 2>&1 -dx12 | tee /tmp/w3.log");
  assert.equal(undo(pp.text, record(undefined, pp.added, 100, pp.args)), piped);
  assert.deepEqual(autoArgs(W3, "XESS_FG=3 %command% -dx12|tee l"), [], "already the game's argument");
  // a typo or an unsafe argument: nothing
  assert.deepEqual(plan("XESS_FG=3 %command", [], undefined, [{ arg: "-dx12", why: "" }]).args, []);
  assert.deepEqual(plan("%command%", [], undefined, [{ arg: "$(rm)", why: "" }]).args, []);
  // stored and read back
  const rl = readLog({ [W3]: { ...rec, args: ["-dx12", "a b", 3], argsDone: ["-dx12"] } });
  assert.deepEqual(rl[W3].args, ["-dx12"]);
  assert.deepEqual(rl[W3].argsDone, ["-dx12"]);
  // a record without arguments keeps its old shape
  assert.equal("args" in record(undefined, [XESS], 1), false);
});

test("AutoLaunch passes the DirectX 12 argument to plan and records it", () => {
  const s = readFileSync(new URL("../../src/components/AutoLaunch.tsx", import.meta.url), "utf8");
  assert.match(s, /plan\(text, suggest, rec, autoArgs\(appid, text\), gi\.game\?\.opti_installed \? OPTI_DROPPED : \[\]\)/);
  assert.match(s, /record\(rec, p\.added, Math\.floor\(Date\.now\(\) \/ 1000\), p\.args\)/);
  assert.match(s, /if \(!suggest\.length && !dx12Known\(appid\)\) return none;/);
});
