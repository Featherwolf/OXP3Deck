// Tests for the automatic setup (DESIGN.md "Automatic setup (0.6)"): autolaunch.ts's merge rules, autosetup.ts's texts,
// handSet, the queue and the pass with fake Steam and backend calls, and the wiring of the components.
// Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const { applyAuto, undoAuto, touched, appliedText, appliedAny } = await import("../../src/autolaunch.ts");
const a = await import("../../src/autosetup.ts");
const { EFFECTS } = await import("../../src/effects.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const LP = (o = {}) => ({ set: {}, remove: [], dll_override: null, dxvk_config: null, args: [], ...o });
const W3 = "292030", MHW = "2246340";

// ---- applyAuto / undoAuto / touched ----------------------------------------------------------------------------------

test("applyAuto takes the crash keys out as single tokens, keeping the rest byte for byte", () => {
  const user = "PROTON_LOG=1  XESS_FG=3 FSR=xess  gamemoderun %command%  -novid";
  const r = applyAuto(user, LP({ remove: ["XESS_FG", "FSR", "FSR_FG"] }));
  assert.equal(r.text, "PROTON_LOG=1  gamemoderun %command%  -novid");
  assert.deepEqual(r.applied, { set: {}, dropped: { XESS_FG: "3", FSR: "xess" }, args: [] });
  assert.equal(appliedText(r.applied), "no XESS_FG no FSR");
  assert.ok(appliedAny(r.applied));
  // round trip: the keys come back
  assert.equal(undoAuto(r.text, r.applied), "PROTON_LOG=1  XESS_FG=3 FSR=xess gamemoderun %command%  -novid");
  // a quoted user value comes back quoted
  const q = applyAuto("MESA='26.1' %command%", LP({ remove: ["MESA"] }));
  assert.equal(undoAuto(q.text, { ...q.applied, dropped: { FSR: "a b" } }), "FSR='a b' %command%");
  // only the managed keys: nothing else left but %command% → ""
  const only = applyAuto("XESS_FG=2 %command%", LP({ remove: ["XESS_FG"] }));
  assert.equal(only.text, "");
  assert.equal(undoAuto(only.text, only.applied), "XESS_FG=2 %command%");
  // a key the text does not have: nothing
  assert.deepEqual(applyAuto("A=1 %command%", LP({ remove: ["FSR"] })), { text: "A=1 %command%", applied: { set: {}, dropped: {}, args: [] } });
});

test("applyAuto adds only absent keys, never NEVER_AUTO or skip keys, never over a user value", () => {
  const user = "PROTON_LOG=1   gamemoderun  %command%  -dx11";
  const r = applyAuto(user, LP({ set: { XESS: "latest" } }));
  assert.equal(r.text, "PROTON_LOG=1   XESS=latest gamemoderun  %command%  -dx11");
  assert.deepEqual(r.applied.set, { XESS: "latest" });
  assert.equal(undoAuto(r.text, r.applied), user, "round trip restores the text");
  // the user's own value stays
  assert.equal(applyAuto("XESS=dp4a %command%", LP({ set: { XESS: "latest" } })).text, "XESS=dp4a %command%");
  // never frame generation from an automatic key change, never a skip key
  assert.equal(applyAuto("%command%", LP({ set: { XESS_FG: "2", FSR_FG: "xess" } })).text, "%command%");
  assert.equal(applyAuto("", LP({ set: { XESS: "latest" } }), [], ["XESS"]).text, "");
  // a value that would need quoting: nothing
  assert.equal(applyAuto("%command%", LP({ set: { XESS: "a b" } })).text, "%command%");
  // keys the user removed after the 0.4 automatic launch options (done) are not added again
  const rec = { added: {}, why: [], at: 1, done: ["XESS"], undone: true, argsDone: ["-dx12"] };
  assert.equal(applyAuto("XESS_FG=3 %command%", LP({ set: { XESS: "latest" } }), [{ arg: "-dx12", why: "" }], [], rec).text, "XESS_FG=3 %command%");
});

test("applyAuto: removal and addition together, the arguments, a typo, undo after a user change", () => {
  const user = "XESS_FG=3 %command% --launcher-skip 2>&1 | tee /tmp/l";
  const r = applyAuto(user, LP({ set: { XESS: "latest" }, remove: ["FSR"], args: ["-dx12"] }));
  assert.equal(r.text, "XESS_FG=3 XESS=latest %command% --launcher-skip 2>&1 -dx12 | tee /tmp/l");
  assert.deepEqual(r.applied.args, ["-dx12"]);
  assert.equal(undoAuto(r.text, r.applied), user);
  // autoArgs for a DX12 game merges with the plan's args (no duplicate)
  const both = applyAuto("XESS_FG=3 %command%", LP({ args: ["-dx12"] }), [{ arg: "-dx12", why: "" }]);
  assert.deepEqual(both.applied.args, ["-dx12"]);
  assert.equal(both.text, "XESS_FG=3 %command% -dx12");
  // a %command typo: nothing at all
  const typo = "XESS_FG=3 %command -dx11";
  assert.deepEqual(applyAuto(typo, LP({ set: { XESS: "latest" }, remove: ["XESS_FG"] })).text, typo);
  // the plan's set key that is also in remove is not removed
  assert.equal(applyAuto("XESS=dp4a %command%", LP({ set: { XESS: "latest" }, remove: ["XESS"] })).text, "XESS=dp4a %command%");
  // dll_override / dxvk_config are OptiScaler's: ignored here
  assert.equal(applyAuto("%command%", LP({ dll_override: "dxgi", dxvk_config: "dxgi.customVendorId = 8086" })).text, "%command%");
  // Undo keeps a value the user changed since, and a dropped key the user set again
  const changed = r.text.replace("XESS=latest", "XESS=dp4a");
  assert.equal(undoAuto(changed, r.applied), "XESS_FG=3 XESS=dp4a %command% --launcher-skip 2>&1 | tee /tmp/l");
  const d = applyAuto("FSR=xess %command%", LP({ remove: ["FSR"] }));
  assert.equal(undoAuto("FSR=inject %command%", d.applied), "FSR=inject %command%");
});

test("touched: a set key gone or changed, an argument gone, a dropped key back", () => {
  const r = applyAuto("XESS_FG=2 %command%", LP({ set: { XESS: "latest" }, remove: ["XESS_FG"], args: ["-dx12"] }));
  assert.equal(r.text, "XESS=latest %command% -dx12");
  assert.equal(touched(r.text, r.applied), false);
  assert.equal(touched("XESS=dp4a %command% -dx12", r.applied), true);
  assert.equal(touched("XESS=latest %command%", r.applied), true);
  assert.equal(touched("XESS=latest XESS_FG=2 %command% -dx12", r.applied), true);
  assert.equal(touched("XESS=latest gamemoderun %command% -dx12 -novid", r.applied), false, "other words are not ours");
  assert.equal(touched(null, r.applied), false, "unreadable: cannot tell");
});

// ---- handSet ---------------------------------------------------------------------------------------------------------

test("handSet: OXP3 Deck's keys set by hand, less the old automatic log, OptiScaler's log and live changes", () => {
  assert.deepEqual(a.handSet("", null, null, "1"), []);
  assert.deepEqual(a.handSet(null, null, null, "1"), []);
  assert.deepEqual(a.handSet("gamemoderun PROTON_LOG=1 %command% --launcher-skip", null, null, W3), [], "unmanaged words ignored");
  assert.deepEqual(a.handSet("XESS=latest XESS_FG=3 %command% -dx12", null, null, W3), ["XESS=latest", "XESS_FG=3", "-dx12"]);
  // the 0.4 automatic launch options added XESS=latest and -dx12
  const rec = { added: { XESS: "latest" }, why: [], at: 1, done: ["XESS"], undone: false, args: ["-dx12"] };
  assert.deepEqual(a.handSet("XESS=latest XESS_FG=3 %command% -dx12", rec, null, W3), ["XESS_FG=3"]);
  // an undone record accounts for nothing
  assert.deepEqual(a.handSet("XESS=latest %command%", { ...rec, undone: true }, null, W3), ["XESS=latest"]);
  // OptiScaler's plan: XESS_FG, WINEDLLOVERRIDES, -dx12
  const opti = { plan: { set: { XESS_FG: "2" }, remove: [], dll_override: "dxgi", dxvk_config: null, args: ["-dx12"] }, dropped: {}, args: ["-dx12"],
    lists: ["WINEDLLOVERRIDES"], at: 1, pending: false, want: null };
  assert.deepEqual(a.handSet("WINEDLLOVERRIDES=dxgi=n,b XESS_FG=2 %command% -dx12", null, opti, W3), []);
  assert.deepEqual(a.handSet("WINEDLLOVERRIDES=dxgi=n,b DXVK_CONFIG=x XESS_FG=3 %command%", null, opti, W3), ["XESS_FG=3", "DXVK_CONFIG"]);
  // a live automatic change
  assert.deepEqual(a.handSet("XESS=latest %command%", null, null, "7", [{ set: { XESS: "latest" }, dropped: {}, args: [] }]), []);
  // -dx12 counts for any game (dx12Arg's default)
  assert.deepEqual(a.handSet("%command% -dx12", null, null, "7"), ["-dx12"]);
});

// ---- texts -----------------------------------------------------------------------------------------------------------

const change = (o) => ({ id: `${o.kind}-1`, at: 1700000000, state: "live", tested: false, kept: false, accepted: false, label: "", why: "", short: "", ...o });
const OPTI = change({ kind: "opti", label: "OptiScaler", short: "for frame generation", why: "XeSS frame generation adds no fps here; OptiScaler's XeFG is the known way." });
const PROTON = change({ kind: "proton", label: "GE-Proton11-11", short: "for XeSS", why: "Its Proton lacks the XeSS add-on.",
  proton: { from: "proton-cachyos", from_priority: 100, to: "GE-Proton11-11", to_display: "GE-Proton11-11" } });
const LAUNCH = change({ kind: "launch", label: "XESS=latest -dx12", short: "for XeSS", why: "XeSS 1.3.1 is older than 2.0.2.68. It would run slower.",
  launch: { set: { XESS: "latest" }, dropped: {}, args: ["-dx12"] } });
const GAME = (changes = [], o = {}) => ({ appid: W3, name: "The Witcher 3", class: "known", skip_why: null, mode: "auto", mode_why: null, mode_by: "default",
  seen_at: 1, plan_version: 1, changes, session: { started_at: null, quick_exits: 0, last_run_s: null }, rollback_due: null, notice: null, last_error: null, ...o });

test("summaryLine, changeRow, toastText, rollbackText: plain words, at most 80 characters", () => {
  assert.equal(a.summaryLine(GAME([OPTI, LAUNCH])), "OptiScaler, newer XeSS, DirectX 12 · for frame generation");
  assert.equal(a.summaryLine(GAME([])), "");
  assert.equal(a.summaryLine(GAME([{ ...OPTI, state: "undone" }])), "");
  assert.deepEqual(a.changeRow(PROTON), { label: "Proton changed to GE-Proton11-11 for XeSS", line: "Its Proton lacks the XeSS add-on." });
  assert.equal(a.changeRow(OPTI).label, "OptiScaler installed");
  assert.equal(a.changeRow(LAUNCH).label, "Launch options: XESS=latest -dx12");
  assert.equal(a.toastText("The Witcher 3", [OPTI, LAUNCH]), "Set up The Witcher 3: OptiScaler, newer XeSS, DirectX 12. Applies at its next start.");
  assert.match(a.toastText("The Witcher 3", [OPTI], { upscaler: "xess", fg: 2, fg_input: "dlssg" }), /Applies at its next start\. .*DLSS/);
  assert.equal(a.rollbackText(OPTI, "The Witcher 3"), "The Witcher 3 closed within a minute after OptiScaler.");
  const long = "A Game With A Really Very Extremely Long Name That Goes On And On: The Sequel Edition";
  const texts = [a.summaryLine(GAME([OPTI, LAUNCH, PROTON])), a.changeRow(PROTON).label, a.changeRow(LAUNCH).line, a.rollbackText(LAUNCH, long),
    a.switchLine(true, false), a.switchLine(false, true), a.switchLine(false, false),
    a.modeLine({ class: "known", mode: "auto", mode_why: null, skip_why: null }), a.modeLine({ class: "known", mode: "manual", mode_why: null, skip_why: null }),
    a.modeLine({ class: "skipped", mode: "auto", mode_why: null, skip_why: `${long} uses anti-cheat (EasyAntiCheat), so OXP3 Deck changes nothing by itself.` }),
    a.protonLine({ kind: "none", line: "Install GE-Proton or Proton Experimental, then restart Steam.", detail: "d" }).label,
    a.protonLine({ kind: "restart", line: "Restart Steam to use GE-Proton11-11.", detail: "" }).label,
    a.protonLine({ kind: "user_pick", line: "Your Proton for X lacks the XeSS add-on.", detail: "" }).line, a.fit(long + long)];
  for (const t of texts) assert.ok(t.length <= 80, `${t.length}: ${t}`);
  assert.equal(a.protonLine({ kind: "restart", line: "Restart Steam to use GE-Proton11-11.", detail: "" }).label, "Restart Steam to use GE-Proton11-11");
  assert.equal(a.protonLine({ kind: "unhooked", line: "x", detail: "" }).label, "Listed Proton lacks the XeSS add-on");
  assert.equal(a.switchLine(true, false), "OXP3 Deck sets up games after you quit them. Undo any time.");
  assert.equal(a.switchLine(false, true), "Replaces 'Add needed launch options automatically': turn on to keep it.");
  assert.equal(a.switchLine(false, false), "Off: you set up each game yourself.");
  assert.equal(a.modeLine({ class: "known", mode: "manual", mode_why: "You set its launch options yourself.", skip_why: null }), "You set its launch options yourself.");
  assert.deepEqual(a.plannedLabels({ rollback: null, proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "" }, opti: { choices: {}, why: "", short: "" },
    launch: { plan: LP({ set: { XESS: "latest" }, remove: ["FSR"], args: ["-dx12"] }), why: "", short: "" } }), ["GE-Proton11-11", "OptiScaler", "XESS=latest -dx12 no FSR"]);
});

test("confirmEnable: the five paragraphs, the effect, anti-cheat, Undo and the one-minute rule", () => {
  const c = a.confirmEnable("deck");
  assert.equal(c.title, "Set up games automatically?");
  assert.equal(c.ok, "Turn on");
  assert.equal(c.effect, EFFECTS["auto.global"]);
  assert.equal(c.text.length, 5);
  const all = c.text.join(" ");
  assert.match(all, /anti-cheat/);
  assert.match(all, /Undo/);
  assert.match(all, /within a minute/);
  assert.match(all, /quit it that quickly yourself/);
  assert.match(all, /A Proton you picked for a game is never changed\./);
  assert.equal(c.linesTitle, "May change:");
  assert.deepEqual(c.lines, ["Steam launch options (only OXP3 Deck's keys)", "A game's Proton (SpecifyCompatTool)", "OptiScaler files in a game folder (as deck)"]);
  for (const ch of [OPTI, PROTON, LAUNCH]) {
    const u = a.undoConfirm(ch, "The Witcher 3");
    assert.equal(u.effect, EFFECTS["game.auto_undo"]);
    assert.match(u.text.join(" "), /Manual/);
  }
  assert.match(a.undoConfirm(PROTON, "X").text[0], /back to Steam's default/);
  assert.match(a.undoConfirm({ ...PROTON, proton: { ...PROTON.proton, from: "GE-Proton10-25", from_priority: 250 } }, "X").text[0], /back to GE-Proton10-25/);
  assert.equal(a.offerConfirm({ id: "fsr", label: "FSR → XeSS", line: "l", why: "w" }, "X").effect, EFFECTS["game.auto_offer"]);
});

test("the queue runs one pass at a time and drops a second request for the same game", async () => {
  const q = a.makeQueue();
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const p1 = q.run("1", async () => { order.push("1 start"); await gate; order.push("1 end"); return 1; });
  const p1b = q.run("1", async () => { order.push("1 again"); return 9; });
  const p2 = q.run("2", async () => { order.push("2"); return 2; });
  assert.equal(await p1b, null);
  assert.ok(q.has("1") && q.has("2"));
  release();
  assert.deepEqual([await p1, await p2], [1, 2]);
  assert.deepEqual(order, ["1 start", "1 end", "2"]);
  assert.equal(q.has("1"), false);
  const failing = await q.run("3", async () => { throw new Error("x"); });
  assert.equal(failing, null);
  assert.equal(await q.run("4", async () => 4), 4, "a failed pass does not stop the queue");
});

// ---- the pass with fakes ---------------------------------------------------------------------------------------------

const plan = (o = {}) => ({ appid: "10", name: "Game", on: true, class: "known", skip_why: null, mode: "auto", mode_why: null,
  opti: null, launch: null, proton: null, proton_note: null, offers: [], rollback: null, needs_xess: false, game: GAME([], { appid: "10", name: "Game" }), ...o });

/** Fake Steam and backend; `log` lists every call in order. */
const fakes = (p, o = {}) => {
  const log = [];
  const st = { text: o.text ?? "", compat: o.compat ?? { name: "proton-cachyos", display: "Proton CachyOS", priority: 100 }, running: o.running ?? false,
    optiIn: o.optiIn ?? false, toasts: [], recorded: [] };
  const d = {
    facts: async () => { log.push("facts"); return { compat: st.compat, tools: o.tools ?? [], hand: [], running: st.running }; },
    plan: async (appid, facts) => { log.push(`plan ${facts.running}`); return { ok: true, error: null, plan: typeof p === "function" ? p() : p }; },
    isRunning: () => { log.push("isRunning"); return typeof st.running === "function" ? st.running() : st.running; },
    getLaunchOptions: async () => { log.push("get"); return st.text; },
    setLaunchOptions: async (appid, text) => { log.push(`set ${text}`); st.text = text; return { ok: true, error: null, text }; },
    setCompatTool: async (appid, name) => {
      log.push(`compat ${name}`);
      if (o.compatFails) return { ok: false, error: "Steam did not take the Proton change.", name: st.compat.name };
      st.compat = { name, display: name, priority: name ? 250 : 0 };
      return { ok: true, error: null, name };
    },
    record: async (appid, c) => {
      log.push(`record ${c.kind}`);
      if (o.recordFails) return { ok: false, error: "refused", game: null };
      st.recorded.push(c);
      return { ok: true, error: null, game: GAME([{ ...change({ kind: c.kind, label: c.label, why: c.why, short: c.short }), launch: c.launch, proton: c.proton }], { appid }) };
    },
    mode: async (appid, mode, why) => { log.push(`mode ${mode} ${why}`); return { ok: true, error: null, game: GAME([], { mode }) }; },
    undo: async (appid, id, reason) => {
      log.push(`undo ${id} ${reason}`);
      return { ok: true, error: null, game: GAME([], { notice: "Game closed within a minute after OXP3 Deck set it up, so that change is undone." }),
        job: id.startsWith("opti") ? { id: "j2", kind: "opti-remove", state: "running" } : null };
    },
    optiInstall: async (appid, accepted) => { log.push(`opti ${accepted}`); return o.optiRefused ? { ok: false, error: "A file is in the way (dxgi.dll)", job: null } : { ok: true, error: null, job: { id: "j1", kind: "opti-install", state: "running" } }; },
    waitJob: async (j) => { log.push(`wait ${j.id}`); return { ...j, state: o.jobFails ? "failed" : "done", error: o.jobFails ? "boom" : null,
      result: { ok: !o.jobFails, launch: LP({ set: { XESS_FG: "2" }, remove: ["XESS"], dll_override: "dxgi", args: ["-dx12"] }) } }; },
    syncOpti: async (appid, want) => { log.push(`syncOpti ${want ? "plan" : "null"}`); st.optiIn = !!want; return { error: null }; },
    optiIn: async () => st.optiIn,
    legacyRec: async () => o.legacyRec,
    toast: (t) => { log.push("toast"); st.toasts.push(t); },
  };
  return { d, log, st };
};

test("the pass: switch off, skipped, Manual or running: nothing written", async () => {
  for (const [p, why] of [[plan({ on: false }), "off"], [plan({ class: "skipped", skip_why: "anti-cheat" }), "skipped"], [plan({ mode: "manual" }), "manual"]]) {
    const { d, log } = fakes({ ...p, proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "" }, launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } });
    const r = await a.runPass(d, "10", "Game", "scan");
    assert.equal(r.stopped, why);
    assert.ok(!log.some((l) => /^(set|compat|opti|record)/.test(l)), `${why}: ${log}`);
  }
  const { d, log } = fakes(plan({ launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } }), { running: true });
  const r = await a.runPass(d, "10", "Game", "open");
  assert.equal(r.stopped, "running");
  assert.equal(r.waiting, true);
  assert.ok(!log.some((l) => l.startsWith("set ")));
});

test("the pass: a rollback that is due is undone before anything else, and nothing else happens", async () => {
  const rb = { ...LAUNCH, id: "launch-5", launch: { set: { XESS: "latest" }, dropped: { XESS_FG: "3" }, args: [] } };
  const { d, log, st } = fakes(plan({ rollback: rb, proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "" },
    launch: { plan: LP({ set: { FSR: "xess" } }), why: "", short: "" } }), { text: "XESS=latest %command%" });
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.equal(r.stopped, "rollback");
  assert.equal(r.rolledBack.id, "launch-5");
  assert.equal(st.text, "XESS_FG=3 %command%");
  const writes = log.filter((l) => /^(set|compat|opti|record|undo)/.test(l));
  assert.deepEqual(writes, ["set XESS_FG=3 %command%", "undo launch-5 rollback"], "the undo write, then auto_undo; no Proton, no new keys");
  assert.equal(st.toasts.length, 1);
  assert.match(st.toasts[0], /closed within a minute/);
  // a Proton rollback puts the old pick back ("" for Steam's default)
  const pr = fakes(plan({ rollback: { ...PROTON, id: "proton-3" } }));
  await a.runPass(pr.d, "10", "Game", "exit");
  assert.deepEqual(pr.log.filter((l) => /^(compat|undo)/.test(l)), ["compat ", "undo proton-3 rollback"]);
  // an OptiScaler rollback: the remove job, then OptiScaler's launch options out
  const op = fakes(plan({ rollback: { ...OPTI, id: "opti-2" } }));
  await a.runPass(op.d, "10", "Game", "exit");
  assert.deepEqual(op.log.filter((l) => /^(undo|wait|syncOpti)/.test(l)), ["undo opti-2 rollback", "wait j2", "syncOpti null"]);
});

test("the pass checks isRunning right before every write: a game that starts mid-pass gets nothing more", async () => {
  // running turns true after the Proton step: OptiScaler and the launch options wait
  let n = 0;
  const { d, log, st } = fakes(plan({ proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "w" }, opti: { choices: {}, why: "", short: "" },
    launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } }));
  st.running = () => { n++; return n > 2; };
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.equal(r.stopped, "running");
  assert.ok(log.includes("compat GE-Proton11-11"));
  assert.ok(!log.some((l) => l.startsWith("opti ") || l.startsWith("set ")), log.join(", "));
  // every write in the log comes right after an isRunning check
  const full = fakes(plan({ proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "w" },
    launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } }));
  await a.runPass(full.d, "10", "Game", "exit");
  full.log.forEach((l, i) => {
    if (/^(set |compat |opti )/.test(l)) assert.equal(full.log[i - 1], "isRunning", `${l} after ${full.log[i - 1]}`);
  });
});

test("the pass: a Proton that Steam did not take is not recorded; the rest goes on", async () => {
  const { d, log, st } = fakes(plan({ proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "w" },
    launch: { plan: LP({ set: { XESS: "latest" } }), why: "w", short: "for XeSS" } }), { compatFails: true });
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.equal(r.error, "Steam did not take the Proton change.");
  assert.ok(!log.includes("record proton"));
  assert.deepEqual(st.recorded.map((c) => c.kind), ["launch"]);
  assert.equal(st.text, "XESS=latest %command%");
});

test("the pass: Proton move recorded with what was there before; launch change recorded; one toast", async () => {
  const { d, st } = fakes(plan({ proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "Its Proton lacks the XeSS add-on." },
    launch: { plan: LP({ set: { XESS: "latest" } }), why: "XeSS 1.3 is old.", short: "for XeSS" } }), { text: "gamemoderun %command%" });
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.equal(r.error, null);
  assert.deepEqual(st.recorded[0].proton, { from: "proton-cachyos", from_priority: 100, to: "GE-Proton11-11", to_display: "GE-Proton11-11" });
  assert.equal(st.recorded[0].short, "for XeSS");
  assert.deepEqual(st.recorded[1].launch, { set: { XESS: "latest" }, dropped: {}, args: [] });
  assert.equal(st.recorded[1].label, "XESS=latest");
  assert.equal(st.text, "XESS=latest gamemoderun %command%");
  assert.equal(st.toasts.length, 1);
  assert.equal(st.toasts[0], "Set up Game: GE-Proton11-11, newer XeSS. Applies at its next start.");
  // nothing to do: no toast
  const none = fakes(plan({ launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } }), { text: "XESS=dp4a %command%" });
  const n = await a.runPass(none.d, "10", "Game", "scan");
  assert.equal(none.st.toasts.length, 0);
  assert.deepEqual(n.changes, []);
});

test("the pass: OptiScaler's job, then its launch plan, then the launch keys without the ones OptiScaler drops", async () => {
  const { d, log, st } = fakes(plan({ name: "The Witcher 3", opti: { choices: { upscaler: "xess", fg: 2, fg_input: "dlssg" }, why: "XeFG.", short: "for frame generation" },
    launch: { plan: LP({ set: { XESS: "latest" }, remove: ["FSR"] }), why: "w", short: "s" } }), { text: "FSR=xess %command%" });
  const r = await a.runPass(d, W3, "", "exit");
  const order = log.filter((l) => /^(opti|wait|syncOpti|set|record)/.test(l));
  assert.deepEqual(order, ["opti false", "wait j1", "syncOpti plan", "set ", "record launch"]);
  assert.equal(st.recorded[0].launch.set.XESS, undefined, "XESS is OptiScaler's to drop: not added");
  assert.deepEqual(st.recorded[0].launch.dropped, { FSR: "xess" });
  assert.equal(st.toasts.length, 1);
  assert.match(st.toasts[0], /^Set up The Witcher 3: OptiScaler, crash-prone options out\. Applies at its next start\. /);
  assert.equal(r.changes.length, 2);
  // a refused install: its error, the pass goes on without it
  const ref = fakes(plan({ opti: { choices: {}, why: "", short: "" }, launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } }), { optiRefused: true });
  const rr = await a.runPass(ref.d, "10", "Game", "exit");
  assert.match(rr.error, /in the way/);
  assert.ok(!ref.log.includes("syncOpti plan"));
  assert.equal(ref.st.text, "XESS=latest %command%");
  // a failed job: no launch plan from it
  const fj = fakes(plan({ opti: { choices: {}, why: "", short: "" } }), { jobFails: true });
  const fr = await a.runPass(fj.d, "10", "Game", "exit");
  assert.equal(fr.error, "boom");
  assert.ok(!fj.log.includes("syncOpti plan"));
});

test("the pass: automatic launch options changed in Steam make the game Manual", async () => {
  const live = { ...LAUNCH, launch: { set: { XESS: "latest" }, dropped: {}, args: [] } };
  const { d, log } = fakes(plan({ game: GAME([live]), launch: { plan: LP({ set: { FSR: "xess" } }), why: "", short: "" } }), { text: "XESS=dp4a %command%" });
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.equal(r.stopped, "touched");
  assert.ok(log.includes("mode manual You changed its launch options in Steam."));
  assert.ok(!log.some((l) => l.startsWith("set ")));
});

test("the pass: a change the backend refuses to record is put back (no change without Undo)", async () => {
  const { d, st } = fakes(plan({ proton: { to: "GE-Proton11-11", to_display: "GE-Proton11-11", why: "" },
    launch: { plan: LP({ set: { XESS: "latest" } }), why: "", short: "" } }), { text: "A=1 %command%", recordFails: true });
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.equal(r.error, "refused");
  assert.equal(st.text, "A=1 %command%");
  assert.equal(st.compat.name, "", "the Proton back to Steam's default");
  assert.equal(st.toasts.length, 0);
});

test("undoChange by kind and acceptOffer", async () => {
  const { d, log, st } = fakes(plan(), { text: "XESS=latest %command% -dx12" });
  const u = await a.undoChange(d, "10", LAUNCH, "user", "Game");
  assert.equal(u.ok, true);
  assert.equal(st.text, "");
  assert.ok(log.includes("undo launch-1 user"));
  // never while it runs
  const run = fakes(plan(), { running: true });
  const ru = await a.undoChange(run.d, "10", LAUNCH, "user", "Game");
  assert.equal(ru.ok, false);
  assert.equal(ru.error, "Quit Game first.");
  assert.ok(!run.log.some((l) => /^(set|undo)/.test(l)));
  // offers: FSR as an accepted launch change; Proton by the listed tool's name; OptiScaler with accepted
  const f = fakes(plan(), { text: "%command%" });
  const fr = await a.acceptOffer(f.d, "10", "Game", { id: "fsr", label: "FSR → XeSS", line: "FSR → XeSS: the game's FSR runs on XeSS.", why: "w" }, { tools: [], compat: null });
  assert.equal(fr.ok, true);
  assert.equal(f.st.text, "FSR=xess %command%");
  assert.equal(f.st.recorded[0].accepted, true);
  const p = fakes(plan());
  const pr = await a.acceptOffer(p.d, "10", "Game", { id: "proton", label: "GE-Proton11-11", line: "Use GE-Proton11-11 for XeSS.", why: "" },
    { tools: [{ name: "GE-Proton11-11", display: "GE-Proton11-11" }], compat: { name: "proton_9", display: "Proton 9", priority: 250 } });
  assert.equal(pr.ok, true);
  assert.deepEqual(p.st.recorded[0].proton, { from: "proton_9", from_priority: 250, to: "GE-Proton11-11", to_display: "GE-Proton11-11" });
  assert.equal(p.st.recorded[0].accepted, true);
  const o = fakes(plan());
  await a.acceptOffer(o.d, "10", "Game", { id: "opti", label: "OptiScaler", line: "", why: "" }, { tools: [], compat: null });
  assert.deepEqual(o.log.filter((l) => /^(opti|wait|syncOpti)/.test(l)), ["opti true", "wait j1", "syncOpti plan"]);
});

// ---- wiring ------------------------------------------------------------------------------------------------------------

const SRC = new URL("../../src/", import.meta.url);
const allSources = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`);
      else if (/\.tsx?$/.test(e.name)) out.push(`${dir}${e.name}`);
    }
  };
  walk("");
  return out;
};

/** The body of the function (an arrow const) that contains index `i`. */
const enclosing = (s, i) => s.slice(Math.max(s.lastIndexOf("\nconst ", i), s.lastIndexOf("\nexport const ", i), s.lastIndexOf(" const ", i)), i);

test("SpecifyCompatTool only in steam.ts; AutoSetup.tsx writes only after an isRunning check in the same function", () => {
  const users = allSources().filter((n) => /SpecifyCompatTool\(/.test(src(n)));
  assert.deepEqual(users, ["steam.ts"]);
  const s = src("components/AutoSetup.tsx");
  const calls = [...s.matchAll(/\b(setLaunchOptions|setCompatTool)\(/g)].filter((m) => !/import/.test(s.slice(s.lastIndexOf("\n", m.index), m.index)));
  assert.ok(calls.length >= 2, "both writers");
  for (const m of calls) {
    const fn = enclosing(s, m.index);
    assert.match(fn, /isRunning\(/, `${m[0]} without isRunning( before it in the same function`);
  }
  // the pass gets exactly these guarded writers
  assert.match(s, /setLaunchOptions: writeLaunch,/);
  assert.match(s, /setCompatTool: writeCompat,/);
});

test("markManual in GameControls' write and OptiControls' install/update/remove/choice handlers", () => {
  const g = src("components/GameControls.tsx");
  const write = g.slice(g.indexOf("const write = async"), g.indexOf("const change = "));
  assert.match(write, /if \(r\.ok\) markManual\(app\.appid, /);
  const o = src("components/OptiControls.tsx");
  const startJob = o.slice(o.indexOf("const startJob = async"), o.indexOf("const install = "));
  assert.match(startJob, /markManual\(appid, /);
  for (const h of ["const install = ", "const remove = ", "const update = "]) assert.match(o.slice(o.indexOf(h), o.indexOf(h) + 200), /startJob\(/, h);
  const choose = o.slice(o.indexOf("const choose = "), o.indexOf("const overlay = "));
  assert.match(choose, /markManual\(appid, /);
  // the global overlay is not a per-game change
  assert.doesNotMatch(o.slice(o.indexOf("const overlay = "), o.indexOf("if (!isSteamApp(appid) || !game?.opti_entry)")), /markManual/);
});

test("the switch: one confirm with its effect, then auto_enable(true, true); the old toggle and dropdown are gone", () => {
  const s = src("components/AutoSetup.tsx");
  const sw = s.slice(s.indexOf("export const AutoSetupSwitch"), s.indexOf("// ---- one game"));
  assert.match(sw, /await confirm\(\{ title: t\.title, text: paragraphs\(t\.text\), ok: t\.ok, effect: EFFECTS\["auto\.global"\]/);
  assert.match(sw, /auto_enable\(want, want\)/);
  assert.match(sw, /if \(want\) \{\s*const ok = await confirm/, "a dialog only when turning it on");
  assert.match(sw, /description=\{explainWhen\(switchLine\(on, !!old\.data\?\.on\), EFFECTS\["auto\.global"\]/);
  for (const n of allSources()) {
    assert.doesNotMatch(src(n), /AutoGlobalToggle|AutoLaunchRows|const stopAuto = watchGameExits\(\);|EFFECTS\["game\.auto"\]/, n);
  }
  for (const n of ["pages/Games.tsx", "pages/XeSS.tsx", "pages/Quick.tsx"]) assert.match(src(n), /<AutoSetupSwitch \/>/, n);
  const g = src("components/GameControls.tsx");
  assert.ok(g.indexOf("<AutoSetupRows ") > 0 && g.indexOf("<AutoSetupRows ") < g.indexOf('label={label("XeSS version"'), "above the XeSS options");
  assert.match(src("components/AutoSetup.tsx"), /<LegacyAutoRows app=\{app\}/, "an old record keeps its row and Undo");
});

test("the rows' tags and the exit order; the scan's limits", () => {
  const s = src("components/AutoSetup.tsx");
  for (const id of ["game.auto_mode", "game.auto_undo", "game.auto_retry", "game.auto_offer"]) assert.match(s, new RegExp(`EFFECTS\\["${id.replace(".", "\\.")}"\\]`), id);
  assert.match(s, /export const SCAN_FIRST_MS = 20 \* 1000;/);
  assert.match(s, /export const SCAN_EVERY_MS = 10 \* 60 \* 1000;/);
  assert.match(s, /\.slice\(0, SCAN_MAX\)/);
  assert.match(s, /export const SCAN_MAX = 8;/);
  assert.match(s, /if \(scanning \|\| runningApp\(\)\) return;/, "the scan only while no game runs");
  assert.match(s, /const stopAuto|watchLifetime\(\(appid, running\) => onLifetime\(appid, running\)\)/);
  assert.match(s, /auto_session\(appid, running \? "start" : "exit"\)/);
  assert.match(s, /for \(const id of runningApps\(\)\) if \(!st\.games\?\.\[id\]\?\.session\?\.started_at\) onLifetime\(id, true\);/);
  assert.match(s, /export const JOB_POLL_MS = 2000;/);
  assert.match(s, /export const JOB_MAX_MS = 20 \* 60 \* 1000;/);
});

// ---- the review of 2026-11-06 ----------------------------------------------------------------------------------------

test("review: a rolled-back -dx12 is not added again by the next pass (no apply, crash, apply loop)", async () => {
  const w3 = (changes) => plan({ appid: W3, name: "The Witcher 3", game: GAME(changes),
    launch: { plan: LP({ remove: ["FSR", "FSR_FG"] }), why: "w", short: "keys that break it out" } });
  // control: frame generation set, no -dx12 yet: the pass adds it
  const first = fakes(w3([]), { text: "XESS_FG=2 %command%" });
  await a.runPass(first.d, W3, "The Witcher 3", "exit");
  assert.equal(first.st.text, "XESS_FG=2 %command% -dx12");
  // after the quick exit rolled it back: nothing written, nothing recorded
  const rb = { ...LAUNCH, id: "launch-7", state: "rolled_back", kept: false, launch: { set: {}, dropped: {}, args: ["-dx12"] } };
  const again = fakes(w3([rb]), { text: "XESS_FG=2 %command%" });
  const r = await a.runPass(again.d, W3, "The Witcher 3", "exit");
  assert.deepEqual(r.changes, []);
  assert.ok(!again.log.some((l) => l.startsWith("set ") || l.startsWith("record")), again.log.join(", "));
  // Try again (kept): added once more
  const kept = fakes(w3([{ ...rb, kept: true }]), { text: "XESS_FG=2 %command%" });
  await a.runPass(kept.d, W3, "The Witcher 3", "exit");
  assert.equal(kept.st.text, "XESS_FG=2 %command% -dx12");
});

test("review: the keys OptiScaler takes out do not count as the user's change (no false Manual)", async () => {
  const live = { ...LAUNCH, launch: { set: { XESS: "latest" }, dropped: {}, args: [] } };
  const { d, log } = fakes(plan({ game: GAME([live]) }), { text: "WINEDLLOVERRIDES=dxgi=n,b %command%", optiIn: true });
  const r = await a.runPass(d, "10", "Game", "exit");
  assert.notEqual(r.stopped, "touched");
  assert.ok(!log.some((l) => l.startsWith("mode ")), log.join(", "));
  // without OptiScaler the same text is the user's change
  const off = fakes(plan({ game: GAME([live]) }), { text: "%command%" });
  assert.equal((await a.runPass(off.d, "10", "Game", "exit")).stopped, "touched");
});

test("review: the waiting row names only what would change in the launch options now", () => {
  const p = plan({ appid: MHW, launch: { plan: LP({ remove: ["XESS_FG", "FSR", "FSR_FG"] }), why: "", short: "" } });
  const none = a.launchStep(MHW, "gamemoderun %command%", p, false).applied;
  assert.equal(appliedAny(none), false);
  assert.deepEqual(a.plannedLabels(p, none), []);
  assert.equal(a.hasWork(p, none), false);
  const some = a.launchStep(MHW, "XESS_FG=2 %command%", p, false).applied;
  assert.deepEqual(a.plannedLabels(p, some), ["no XESS_FG"]);
  assert.equal(a.hasWork(p, some), true);
  assert.deepEqual(a.plannedLabels(p), ["no XESS_FG no FSR no FSR_FG"], "without the launch options: the plan's keys");
});

test("review: wiring of Manual, the exit after a lifetime event and the waiting row", () => {
  const s = src("components/AutoSetup.tsx");
  assert.match(s, /const r = await auto_mode\(appid, m, null\);/, "Manual from the dropdown is the user's pick");
  assert.match(s, /if \(!running\) void p\.then\(\(\) => afterExit\(appid, EXIT_RETRIES\)\);/, "the exit pass follows the session exit");
  assert.match(s, /plannedLabels\(plan, launchNow \?\? \{ set: \{\}, dropped: \{\}, args: \[\] \}\)/);
  assert.match(src("autosetup.ts"), /launchStep\(appid, text, plan, optiIn, await d\.legacyRec\(appid\)\)/, "the pass and the row share launchStep");
});
