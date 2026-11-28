// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Per-game launch options through the typed steam.apps.launchOptions methods, writes deferred while
// the game runs, the typo and copy-line fallbacks, the game's files and last run, advice, known
// issues, the one-run XeSS log, the Games tab and the per-game power profile (H1–H20, A10, A16, B10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrokerError, findAll } from "../.bathysphere/packages/fake-host/dist/index.js";
import { APPS, clean, open, oxp3Fixtures, panelTab, POWER_ON, run, start, text } from "./fixtures.mjs";

const sets = (host) => host.callsTo("steam.apps.launchOptions.set");
const lo = (host, appid) => host.state.apps.get(appid).launchOptions;
// a log written "now" by the game: later than both the host's manual clock and the plugin's clock
// (the vm sandbox's Date is real time, the fake host's manual clock starts at a fixed date)
const freshLog = (host, appid, body) => host.state.apps.get(appid).tree.prefix.put("drive_c/igdext_trace.log", body, Math.max(host.clock.now(), Date.now()) + 3600_000);
const section = async (host, appid) => {
  const g = await open(host, "gamePageSection", "game", { appid });
  await run(host, 3000);
  return g;
};

test("XeSS version, DirectX 12, driver, compatibility mode, FSR (H1, H3, H4, H5, H7)", async () => {
  const host = await start();
  try {
    const g = await section(host, 292030);
    await g.change({ label: "XeSS version" }, "latest");
    await host.settle();
    assert.deepEqual(sets(host).at(-1).params, { appid: 292030, vars: { XESS: "latest" } });
    await g.change({ label: "Start in DirectX 12" }, true);
    await g.change({ label: "Graphics driver" }, "26.3");
    await g.change({ label: "Compatibility mode" }, true);
    await host.settle();
    assert.equal(lo(host, 292030), "force_vk_vendor=-1 MESA=26.3 XESS=latest %command% -dx12");
    await g.change({ label: "Start in DirectX 12" }, false);
    await g.change({ label: "XeSS version" }, "");
    await host.settle();
    assert.deepEqual(sets(host).at(-1).params, { appid: 292030, vars: { XESS: null } });
    assert.doesNotMatch(lo(host, 292030), /-dx12|XESS=/);
    assert.match(text(g), /Launch options\nforce_vk_vendor=-1 MESA=26\.3 %command%/);
    assert.equal(g.find({ label: "FSR → XeSS" }), undefined, "FSR needs release 20261104");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("frame generation: 2x–4x, 5x–8x only with the setting, a confirm where it crashes (H2, H12)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [false, true] } }) });
  try {
    let g = await section(host, 292030);
    assert.deepEqual(g.find({ label: "Frame generation" }).options.map((o) => o.value), ["", "2", "3", "4"]);
    await host.setSetting("fgExperimental", true);
    g = await section(host, 292030);
    assert.deepEqual(g.find({ label: "Frame generation" }).options.map((o) => o.value), ["", "2", "3", "4", "5", "6", "7", "8"]);
    const mh = await section(host, 2246340);
    assert.match(text(mh), /Frame generation crashes this game/);
    await mh.change({ label: "Frame generation" }, "");
    await host.settle();
    assert.equal(lo(host, 2246340), "%command%", "turning it off needs no confirm");
    await mh.change({ label: "Frame generation" }, "2");
    await host.settle();
    assert.equal(host.callsTo("ui.confirm").at(-1).params.destructive, true);
    assert.equal(lo(host, 2246340), "%command%", "declined");
    await mh.change({ label: "Frame generation" }, "2");
    await host.settle();
    assert.equal(lo(host, 2246340), "XESS_FG=2 %command%");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("while the game runs the change waits; it is written after the game quits (H11, A10)", async () => {
  const host = await start();
  try {
    await host.launchGame(292030);
    const g = await section(host, 292030);
    await g.change({ label: "XeSS version" }, "dp4a");
    await host.settle();
    assert.equal(sets(host).length, 0, "no write while it runs");
    assert.match(text(g), /Saved when you quit The Witcher 3: Wild Hunt/);
    assert.deepEqual(host.state.storage.get("pendingLaunch").games["292030"].vars, { XESS: "dp4a" });
    await host.stopGame(292030);
    await run(host, 5000);
    assert.equal(lo(host, 292030), "XESS=dp4a %command%");
    assert.deepEqual(host.state.storage.get("pendingLaunch").games, {});
    assert.doesNotMatch(text(g), /Saved when you quit/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a change still waiting when OXP3 Deck restarts after the game quit is written at start (H11, B4)", async () => {
  const host = await start();
  try {
    await host.launchGame(292030);
    const g = await section(host, 292030);
    await g.change({ label: "XeSS version" }, "latest");
    await host.settle();
    host.state.running = [];
    host.state.current = null;
    await host.restart();
    await run(host, 6000, 1000);
    assert.equal(lo(host, 292030), "XESS=latest %command%");
    assert.deepEqual(host.state.storage.get("pendingLaunch").games, {});
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a launch-options typo blocks writes: the typo card (H8)", async () => {
  const apps = APPS.map((a) => (a.appid === 570 ? { ...a, launchOptions: 'XESS=latest "%command%' } : a));
  const host = await start({ fixtures: oxp3Fixtures({ steam: { apps } }) });
  try {
    const g = await section(host, 570);
    assert.match(text(g), /Launch options typo/);
    assert.ok(findAll(g.tree, { type: "instructions" }).some((n) => n.id === "launch-typo"));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Steam's write path off: the whole line to copy by hand (H10, A16)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ health: { l2: false } }) });
  try {
    const g = await section(host, 292030);
    await g.change({ label: "Start in DirectX 12" }, true);
    await host.settle();
    assert.equal(sets(host).at(-1).error.code, "ENOTSUP");
    assert.match(text(g), /Steam did not take the change/);
    assert.ok(findAll(g.tree, { type: "code" }).some((n) => n.text === "%command% -dx12"));
    // the copy row of the full form: its own label, Steam's text with what the game needs (copyopts.ts)
    assert.match(text(g), /Copy launch options\nIncludes what this game needs/);
    assert.ok(findAll(g.tree, { type: "code" }).some((n) => n.text === "XESS=latest %command%"));
    assert.equal(text(g).match(/Steam did not take the change/g).length, 1, "only the refused write says so");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("the game's files, last run, frame-generation refusal, advice (H13–H18)", async () => {
  const apps = APPS.map((a) =>
    a.appid === 292030
      ? { ...a, files: { ...a.files, prefix: { ...a.files.prefix, "drive_c/windows/system32/DriverStore/y": "" } } }
      : a.appid === 570
        ? { ...a, launchOptions: "XESS_FG=2 %command%", files: { install: { "game/bin/win64/libxess.dll": "MZ" }, prefix: { "drive_c/x": "" } }, fileVersions: { "game/bin/win64/libxess.dll": { fileVersion: "2.0.2.68", productVersion: "2.0.2.68" } } }
        : a,
  );
  const host = await start({ fixtures: oxp3Fixtures({ steam: { apps } }) });
  try {
    const g = await section(host, 292030);
    const t = text(g);
    assert.match(t, /XeSS and FidelityFX files: 3\nlibxell\.dll 1\.2\.1\.13, libxess\.dll 1\.3\.0\.0 and libxess_fg\.dll 1\.2\.0\.10/);
    assert.match(t, /Frame generation is refused\nTurn on Xe Low Latency/);
    assert.match(t, /Last run: no sign of fast mode\nThe shim loaded, but the driver saw no XeSS self-test/, "a trace log without the driver's canary");
    assert.match(t, /Proton: GE-Proton11-11/);
    assert.match(t, /Tips\nXeSS 1\.3\.0\.0 is older than 2\.0\.2\.68/);
    assert.match(t, /Second driver store in the prefix/);
    assert.match(t, /XeSS frame generation does not add fps/, "the known issue of The Witcher 3");
    const finds = host.callsTo("steam.gamefiles.find");
    for (let i = 1; i < finds.length; i++) assert.ok(finds[i].at - finds[i - 1].at >= 1000, "game file searches 1 s apart");
    const d = await section(host, 570);
    assert.match(text(d), /No XeSS frame generation in this game/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Save XeSS logs for one run; off after a fresh log, unless Keep logging on (H6)", async () => {
  const host = await start();
  try {
    let g = await section(host, 570);
    await g.change({ label: "Save XeSS logs" }, true);
    await host.settle();
    assert.equal(lo(host, 570), "XESS_LOG=1 %command%");
    await host.launchGame(570);
    await run(host, 60_000, 5000);
    freshLog(host, 570, "igdext: loaded\n");
    await host.stopGame(570);
    await run(host, 10_000, 1000);
    assert.equal(lo(host, 570), "%command%", "logging went off after the run");
    g = await section(host, 570);
    assert.match(text(g), /Logging turned off after one run/);
    await g.change({ label: "Save XeSS logs" }, true);
    await host.settle();
    await g.change({ label: "Keep logging on" }, true);
    await host.settle();
    await host.launchGame(570);
    await run(host, 60_000, 5000);
    freshLog(host, 570, "igdext: loaded again\n");
    await host.stopGame(570);
    await run(host, 10_000, 1000);
    assert.equal(lo(host, 570), "XESS_LOG=1 %command%", "kept on");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Games tab: the running game, else the last one, else a picker; a game's own power profile (H19, H20, B10)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const p = await panelTab(host, "games");
    assert.match(text(p), /No game running/);
    await p.change({ label: "Game" }, "2246340");
    await run(host, 3000);
    assert.match(text(p), /Monster Hunter Wilds/);
    await host.launchGame(570);
    await run(host, 3000);
    assert.match(text(p), /Dota 2/);
    await p.change({ label: "Separate power profile for Dota 2" }, true);
    await run(host, 2000);
    assert.ok(host.state.storage.get("power").profiles["570"]);
    assert.ok(host.state.profiles.rules.some((r) => r.id === "app-570"));
    await host.stopGame(570);
    await run(host, 5000);
    assert.equal(host.state.storage.get("ui").lastGame.appid, 570, "the last game is remembered");
    clean(host);
  } finally {
    await host.stop();
  }
});

// ---- review findings -------------------------------------------------------------------------------

const codeNodes = (s) => findAll(s.tree, { type: "code" });

test("a non-Steam shortcut and unreadable launch options: the same choices as a line to paste (copyopts.ts)", async () => {
  const shortcut = { appid: 3000000001, name: "Cyberpunk (Heroic)", isShortcut: true, installed: true, launchOptions: "", files: { install: {}, prefix: {} } };
  const host = await start({ fixtures: oxp3Fixtures({ steam: { apps: [...APPS, shortcut] }, responders: { "steam.apps.launchOptions.get": (p) => { if (p.appid === 292030) throw new BrokerError("EINTERNAL", "Steam answered nothing"); throw new BrokerError("EPERM", "a shortcut"); } } }) });
  try {
    const g = await open(host, "gamePageSection", "game", { appid: shortcut.appid });
    assert.match(text(g), /Paste these launch options\nOXP3 Deck can't write them for this game/);
    await g.change({ label: "XeSS version" }, "latest");
    await host.settle();
    await g.change({ label: "Frame generation" }, "3");
    await host.settle();
    await g.change({ label: "Start in DirectX 12" }, true);
    await host.settle();
    assert.ok(codeNodes(g).some((n) => n.text === "XESS=latest XESS_FG=3 %command% -dx12" && n.copy !== false), codeNodes(g).map((n) => n.text).join(" | "));
    assert.equal(sets(host).length, 0, "nothing is written for a shortcut");
    const w = await section(host, 292030);
    assert.match(text(w), /Launch options: not read/);
    assert.match(text(w), /Paste these launch options\nSteam didn't return them/);
    await w.change({ label: "XeSS version" }, "dp4a");
    await host.settle();
    assert.ok(codeNodes(w).some((n) => n.text === "XESS=dp4a %command%"));
    assert.equal(sets(host).length, 0);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Copy launch options: with what waits for the game to quit; no row when the line is empty (copyopts.ts)", async () => {
  const host = await start();
  try {
    const d = await section(host, 570);
    assert.equal(d.find({ label: "Copy launch options" }), undefined, "empty options, nothing to add");
    assert.doesNotMatch(text(d), /Steam did not take the change/);
    await host.launchGame(292030);
    const w = await section(host, 292030);
    await w.change({ label: "Frame generation" }, "3");
    await host.settle();
    assert.match(text(w), /Copy launch options\nWith the change that waits for the game to quit/);
    assert.ok(codeNodes(w).some((n) => n.text === "XESS=latest XESS_FG=3 %command% -dx12"), codeNodes(w).map((n) => n.text).join(" | "));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("launch options with invisible characters: shown without Copy, the tree stays valid (§6.2)", async () => {
  const apps = APPS.map((a) => (a.appid === 292030 ? { ...a, launchOptions: "DXVK_ASYNC=1\u200b %command%" } : a.appid === 570 ? { ...a, launchOptions: "PROTON_LOG=1 %command% -novid\r" } : a));
  const host = await start({ fixtures: oxp3Fixtures({ steam: { apps }, health: { l2: false } }) });
  try {
    const w = await section(host, 292030);
    await w.change({ label: "XeSS version" }, "latest");
    await host.settle();
    assert.match(text(w), /Steam did not take the change/);
    assert.match(text(w), /Invisible characters/);
    const shown = codeNodes(w).filter((n) => n.text.includes("\u200b"));
    assert.ok(shown.length >= 1 && shown.every((n) => n.copy === false), "no Copy on text with a format character");
    const d = await section(host, 570);
    assert.ok(codeNodes(d).filter((n) => n.text.includes("\r")).every((n) => n.copy === false));
    await open(host, "gamePageSection", "game", { appid: 292030 });
    clean(host);
  } finally {
    await host.stop();
  }
});

test("dialog titles stay within 80 characters for long game names (§5.3 host dialogs)", async () => {
  const long = "The Legend of Heroes: Trails of Cold Steel IV - The End of Saga";
  const apps = APPS.map((a) => (a.appid === 570 ? { ...a, name: long } : a));
  const host = await start({ fixtures: oxp3Fixtures({ steam: { apps }, storage: POWER_ON, dialogs: { confirm: [true] } }) });
  try {
    const g = await section(host, 570);
    await g.change({ label: /^Separate power profile/ }, true);
    await run(host, 2000);
    await g.change({ label: /^Separate power profile/ }, false);
    await run(host, 2000);
    const c = host.callsTo("ui.confirm").at(-1);
    assert.ok(c && !c.error, "the dialog was shown");
    assert.ok([...c.params.title].length <= 80, c.params.title);
    assert.match(c.params.body, new RegExp(long.replace(/[-:]/g, ".")), "the whole name in the body");
    assert.equal(host.state.storage.get("power").profiles["570"], undefined, "deleted");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("the last run: the patched driver's canary alone means fast mode was used (GameControls.tsx)", async () => {
  const apps = APPS.map((a) => (a.appid === 292030 ? { ...a, files: { ...a.files, prefix: { "drive_c/igdext_kernels/anv_canary": "" } } } : a));
  const host = await start({ fixtures: oxp3Fixtures({ steam: { apps } }) });
  try {
    const g = await section(host, 292030);
    assert.match(text(g), /Last run: fast mode used\nXeSS ran on the XMX cores/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a failed read of the game's files can be read again (Read the game's files again)", async () => {
  // the first search fails (another caller's 1/s window), then the fake host answers again
  const responders = {
    "steam.gamefiles.find": () => {
      delete responders["steam.gamefiles.find"];
      throw new BrokerError("ERATE", "steam.gamefiles.find: 1 per second");
    },
  };
  const host = await start({ fixtures: oxp3Fixtures({ responders }) });
  try {
    const g = await section(host, 292030);
    await run(host, 5000, 1000);
    assert.match(text(g), /Game files: not read/);
    await g.click("Read the game's files again");
    await run(host, 5000, 1000);
    assert.match(text(g), /XeSS and FidelityFX files: 3/);
    assert.doesNotMatch(text(g), /Game files: not read/);
    clean(host);
  } finally {
    await host.stop();
  }
});
