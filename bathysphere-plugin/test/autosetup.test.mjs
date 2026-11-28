// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Automatic setup: the switch with one confirm, a pass after a game quits, never while it runs,
// change rows with Undo, Manual for games set up by hand, the quick-exit rollback and Try again, the
// library scan, skipped games, offers (I1–I7, I9).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrokerError, findAll } from "../.bathysphere/packages/fake-host/dist/index.js";
import { APPS, clean, open, oxp3Fixtures, panelTab, run, start, text } from "./fixtures.mjs";

const AUTO_ON = { auto: { v: 1, on: true, games: {} } };
const lo = (host, appid) => host.state.apps.get(appid).launchOptions;
const game = (host, appid) => host.state.storage.get("auto").games[String(appid)];
const section = async (host, appid) => {
  const g = await open(host, "gamePageSection", "game", { appid });
  await run(host, 3000);
  return g;
};

test("the switch, a pass after the game quits, the change row and Undo (I1–I4, I6)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "games");
    await p.change({ label: "Set up games automatically" }, true);
    await host.settle();
    assert.equal(host.callsTo("ui.confirm").at(-1).params.title, "Set up games automatically?");
    assert.equal(host.state.storage.get("auto").on, true);
    await host.launchGame(292030);
    await run(host, 5000, 1000);
    assert.equal(lo(host, 292030), "", "never while it runs (I5)");
    await host.stopGame(292030);
    await run(host, 8000, 1000);
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    const g = game(host, 292030);
    assert.equal(g.changes.length, 1);
    assert.deepEqual(g.changes[0].set, { XESS: "latest" });
    const s = await section(host, 292030);
    assert.match(text(s), /Launch options: XESS=latest/);
    await s.click("Undo XESS=latest");
    await host.settle();
    assert.equal(lo(host, 292030), "%command%");
    assert.equal(game(host, 292030).mode, "manual", "Undo leaves the game to you");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a game set up by hand is Manual from the start; a hand edit makes a game Manual (I2)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: AUTO_ON }) });
  try {
    await host.launchGame(2246340);
    await host.stopGame(2246340);
    await run(host, 8000, 1000);
    assert.equal(lo(host, 2246340), "XESS_FG=3 %command%", "the user's own XESS_FG stays (the plan's crash rule is in pure.test.mjs)");
    assert.equal(game(host, 2246340).mode, "manual");
    assert.equal(game(host, 2246340).modeWhy, "You set its launch options yourself.");
    await host.launchGame(292030);
    await host.stopGame(292030);
    await run(host, 8000, 1000);
    assert.equal(game(host, 292030).mode, "auto");
    const s = await section(host, 292030);
    await s.change({ label: "Start in DirectX 12" }, true);
    await host.settle();
    assert.equal(game(host, 292030).mode, "manual");
    assert.match(game(host, 292030).modeWhy, /changed its launch options here/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("closed within a minute after a change: undone before the next start, Try again (I7)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: AUTO_ON }) });
  try {
    await host.launchGame(292030);
    await host.stopGame(292030);
    await run(host, 8000, 1000);
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    await host.launchGame(292030);
    await run(host, 20_000, 5000);
    await host.stopGame(292030);
    await run(host, 8000, 1000);
    assert.equal(lo(host, 292030), "%command%", "rolled back");
    assert.equal(game(host, 292030).changes[0].state, "rolled_back");
    const s = await section(host, 292030);
    assert.match(text(s), /The Witcher 3: Wild Hunt closed within a minute after XESS=latest/);
    await s.click("Try again");
    await host.settle();
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    await host.launchGame(292030);
    await run(host, 90_000, 5000);
    await host.stopGame(292030);
    await run(host, 8000, 1000);
    assert.equal(lo(host, 292030), "XESS=latest %command%", "a normal run keeps it");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("the library scan 20 s after start, not while a game runs; online games skipped (I4, I5, I3)", async () => {
  let host = await start({ fixtures: oxp3Fixtures({ storage: AUTO_ON, steam: { apps: APPS, running: [570], current: 570 } }) });
  try {
    await run(host, 30_000, 5000);
    assert.equal(host.callsTo("steam.apps.launchOptions.set").length, 0);
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start({ fixtures: oxp3Fixtures({ storage: AUTO_ON }) });
  try {
    await run(host, 30_000, 5000);
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    assert.equal(lo(host, 2246340), "XESS_FG=3 %command%", "set by hand: Manual");
    assert.equal(lo(host, 570), "", "Dota 2 is online: skipped");
    assert.equal(game(host, 570).cls, "skipped");
    const s = await section(host, 570);
    assert.match(text(s), /Automatic setup: skipped/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("offers: a system Proton gets the GE-Proton card (I8, I9)", async () => {
  const apps = APPS.map((a) => (a.appid === 292030 ? { ...a, compatTool: { name: "proton-cachyos-slr", perGame: true } } : a));
  const host = await start({ fixtures: oxp3Fixtures({ storage: AUTO_ON, steam: { apps } }) });
  try {
    const s = await section(host, 292030);
    assert.match(text(s), /Also possible: GE-Proton/);
    assert.ok(findAll(s.tree, { type: "instructions" }).some((n) => n.id === "ge-proton"));
    assert.match(text(s), /System Proton: XeSS stays on DP4a here/);
    clean(host);
  } finally {
    await host.stop();
  }
});

// ---- review findings -------------------------------------------------------------------------------

/** A stored live change (as a pass records it). */
const liveChange = (over) => ({ id: "launch-1-0", at: 1, label: "XESS=latest", why: "XeSS 1.3.0.0 is older than 2.0.2.68.", set: { XESS: "latest" }, dropped: {}, args: [], state: "live", tested: false, accepted: false, kept: false, ...over });
const autoGame = (over) => ({ name: "The Witcher 3: Wild Hunt", cls: "known", skipWhy: null, mode: "auto", modeWhy: null, planVersion: 1, changes: [liveChange()], quickExits: 0, rollbackDue: null, at: 1, ...over });

test("a key set by hand in Steam after the first pass makes the game Manual, not undone (autosetup.py _hand)", async () => {
  const apps = APPS.map((a) => (a.appid === 2246340 ? { ...a, launchOptions: "" } : a));
  const host = await start({ fixtures: oxp3Fixtures({ storage: AUTO_ON, steam: { apps } }) });
  try {
    await host.launchGame(2246340);
    await host.stopGame(2246340);
    await run(host, 8000, 1000);
    assert.equal(game(host, 2246340).mode, "auto", "seen once with empty launch options");
    host.state.apps.get(2246340).launchOptions = "XESS_FG=3 %command%";
    await host.launchGame(2246340);
    await run(host, 70_000, 5000);
    await host.stopGame(2246340);
    await run(host, 8000, 1000);
    assert.equal(lo(host, 2246340), "XESS_FG=3 %command%", "the user's key stays");
    assert.equal(game(host, 2246340).mode, "manual");
    assert.equal(game(host, 2246340).modeWhy, "You set its launch options yourself.");
    assert.deepEqual(game(host, 2246340).changes, []);
    assert.equal(host.toasts.length, 0);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("an argument a change added and the user removed in Steam: Manual, not added again (autolaunch.ts touched)", async () => {
  const apps = APPS.map((a) => (a.appid === 292030 ? { ...a, launchOptions: "XESS=latest %command%" } : a));
  const storage = { auto: { v: 1, on: true, games: { 292030: autoGame({ changes: [liveChange({ label: "XESS=latest -dx12", args: ["-dx12"] })] }) } } };
  const host = await start({ fixtures: oxp3Fixtures({ storage, steam: { apps } }) });
  try {
    await section(host, 292030);
    assert.equal(game(host, 292030).mode, "manual");
    assert.equal(game(host, 292030).modeWhy, "You changed its launch options in Steam.");
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a due rollback whose write Steam refuses stays due, says so, and runs once Steam takes it", async () => {
  const apps = APPS.map((a) => (a.appid === 292030 ? { ...a, launchOptions: "XESS=latest %command%" } : a));
  const storage = { auto: { v: 1, on: true, games: { 292030: autoGame({ rollbackDue: "launch-1-0", quickExits: 1 }) } } };
  const responders = { "steam.apps.launchOptions.set": () => { throw new BrokerError("ENOTSUP", "steam.apps.launchOptions.set needs L2 (Steam's shim is not connected)"); } };
  const host = await start({ fixtures: oxp3Fixtures({ storage, steam: { apps }, responders }) });
  try {
    await run(host, 25_000, 5000);
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    assert.equal(game(host, 292030).changes[0].state, "live", "not marked as undone");
    assert.equal(game(host, 292030).rollbackDue, "launch-1-0", "still due");
    assert.equal(host.toasts.length, 0, "no success toast");
    const s = await section(host, 292030);
    assert.match(text(s), /Automatic setup: did not work\nSteam did not take the undo of XESS=latest/);
    assert.match(text(s), /Steam did not take the change/, "the line to paste by hand");
    delete responders["steam.apps.launchOptions.set"];
    await run(host, 10 * 60_000, 30_000);
    assert.equal(lo(host, 292030), "%command%", "the next library scan undoes it");
    assert.equal(game(host, 292030).changes[0].state, "rolled_back");
    assert.equal(game(host, 292030).lastError, null);
    assert.match(host.toasts.at(-1).body, /OXP3 Deck undid that change/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Undo while the game runs says to quit it first (AutoSetup.tsx undoOne); the closed group shows a rollback", async () => {
  const apps = APPS.map((a) => (a.appid === 292030 ? { ...a, launchOptions: "XESS=latest %command%" } : a));
  const storage = { auto: { v: 1, on: true, games: { 292030: autoGame({}) } }, ui: { v: 1, groups: { game: true } } };
  const host = await start({ fixtures: oxp3Fixtures({ storage, steam: { apps } }) });
  try {
    await host.launchGame(292030);
    const q = await open(host, "quickAccessTab", "qam");
    await run(host, 3000);
    assert.ok(q.find({ label: "Set up games automatically" }), "the switch in This game (Quick.tsx)");
    await q.click("Undo XESS=latest");
    await host.settle();
    assert.match(text(q), /Not changed\nQuit The Witcher 3: Wild Hunt first\./);
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    clean(host);
  } finally {
    await host.stop();
  }
  const rolled = { auto: { v: 1, on: true, games: { 292030: autoGame({ changes: [liveChange({ state: "rolled_back" })] }) } }, ui: { v: 1, groups: { game: false } } };
  const h2 = await start({ fixtures: oxp3Fixtures({ storage: rolled }) });
  try {
    await h2.launchGame(292030);
    const q = await open(h2, "quickAccessTab", "qam");
    assert.match(text(q), /Undone after a quick exit\nThe Witcher 3: Wild Hunt closed within a minute after XESS=latest/);
    clean(h2);
  } finally {
    await h2.stop();
  }
});
