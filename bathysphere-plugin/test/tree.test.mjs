// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Every surface and every tab renders without an error card or a host problem, on the ONEXPLAYER 3
// and on another device, in the vm sandbox and (when built) the real runtime; every "Run this
// yourself" card names an instruction the manifest declares; the gate keeps hardware untouched on
// other devices (A1, A2, A4, A5, A9, B1, B2, B3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { findAll, walk } from "../.bathysphere/packages/fake-host/dist/index.js";
import { APPS, hwWrites, MODES, open, OTHER_DEVICE, oxp3Fixtures, run, start, text, XESS_HOME } from "./fixtures.mjs";

const TABS = ["power", "cpu", "battery", "games", "xess", "fixes", "buttons", "kernel", "setup"];

/** Checks one tree: cards exist in the manifest, lines follow the one-line rule. */
function checkTree(host, tree, where) {
  const ids = new Set(host.manifest.contributes.instructions.map((i) => i.id));
  for (const n of findAll(tree, { type: "instructions" })) {
    assert.ok(ids.has(n.id), `${where}: unknown instruction ${n.id}`);
    const steps = host.manifest.contributes.instructions.find((i) => i.id === n.id).steps.length;
    for (const s of n.steps ?? []) assert.ok(s >= 0 && s < steps, `${where}: ${n.id} has no step ${s}`);
  }
  walk(tree, (n) => {
    if (n.type === "listItem" && typeof n.description === "string") assert.ok([...n.description].length <= 80, `${where}: long line ${n.description}`);
  });
}

/** Opens every surface and tab and checks each tree. */
async function everySurface(host) {
  const q = await open(host, "quickAccessTab", "qam");
  assert.equal(q.errorCard, undefined);
  assert.equal(q.tree.title, "OXP3 Deck");
  assert.match(text(q), /All settings: OXP3 Deck in Bathysphere Home/);
  checkTree(host, q.tree, "qam");
  const p = await open(host, "panel", "main");
  const tabs = p.find({ type: "tabs" });
  assert.deepEqual(tabs.tabs.map((t) => t.id), TABS, "Kernel is there on CachyOS");
  for (const tab of TABS) {
    await p.change({ type: "tabs" }, tab);
    await run(host, 1500);
    assert.equal(p.errorCard, undefined, tab);
    assert.equal(p.find({ type: "callout", title: /hit an error/ }), undefined, tab);
    checkTree(host, p.tree, tab);
  }
  for (const appid of [292030, 2246340, 570]) {
    const g = await open(host, "gamePageSection", "game", { appid });
    await run(host, 3000);
    assert.equal(g.errorCard, undefined, String(appid));
    checkTree(host, g.tree, `game ${appid}`);
  }
  assert.deepEqual(host.problems, []);
  assert.deepEqual(host.pluginLogs("error"), []);
}

/**
 * A busy device: power control on with advanced CPU options, plugged-in values, low battery for
 * games and game profiles; a game running; a library of 83 games; launch options with a zero-width
 * space and a carriage return; a compile log with control characters.
 */
function busyFixtures() {
  const extra = Array.from({ length: 80 }, (_, i) => ({ appid: 100000 + i, name: `Library game ${i}`, installed: true, installDir: `g${i}`, buildId: 1, launchOptions: "", files: { install: {}, prefix: {} } }));
  const apps = APPS.map((a) => (a.appid === 570 ? { ...a, launchOptions: "PROTON_LOG=1\u200b %command% -novid\r" } : a));
  const profiles = { default: { main: { boostW: 25 } }, 570: { name: "Dota 2", main: { follow: true }, at: 2 }, 292030: { name: "The Witcher 3: Wild Hunt", main: { cpuMinPct: 20 }, ac: { boostW: 40 }, at: 1 } };
  return oxp3Fixtures({
    steam: { apps: [...apps, ...extra], running: [292030], current: 292030 },
    home: { ...XESS_HOME, ".cache/xess-xmx/compile.log": "a\nb\r\n\u0007c\n" },
    storage: { power: { v: 1, enabled: true, options: { splitAc: true, lowGames: true }, profiles }, ui: { v: 1, powerConfirmed: true, advancedCpu: true } },
  });
}

for (const mode of MODES) {
  test(`every surface and tab renders on the ONEXPLAYER 3 (${mode})`, async () => {
    const host = await start({ mode });
    try {
      await everySurface(host);
    } finally {
      await host.stop();
    }
  });

  test(`every surface and tab renders with power control on and odd data (${mode})`, async () => {
    const host = await start({ mode, fixtures: busyFixtures() });
    try {
      await everySurface(host);
      const p = await open(host, "panel", "main");
      await p.change({ type: "tabs" }, "cpu");
      await run(host, 1500);
      assert.ok(p.find({ label: "Performance cores: maximum" }), "the advanced CPU rows rendered");
      await p.change({ type: "tabs" }, "power");
      await run(host, 1500);
      assert.ok(p.find({ type: "chips" }), "the plugged-in slot chips rendered");
    } finally {
      await host.stop();
    }
  });
}

test("another device: a callout, XeSS and games only, no hardware call at all (B1)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ device: { ...OTHER_DEVICE, knobs: {} } }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Not an ONEXPLAYER 3/);
    assert.match(text(q), /XeSS/);
    assert.doesNotMatch(text(q), /Power control/);
    const p = await open(host, "panel", "main");
    assert.deepEqual(p.find({ type: "tabs" }).tabs.map((t) => t.id), ["games", "xess", "setup"]);
    for (const tab of ["games", "xess", "setup"]) {
      await p.change({ type: "tabs" }, tab);
      await run(host, 1000);
      assert.equal(p.errorCard, undefined, tab);
    }
    const g = await open(host, "gamePageSection", "game", { appid: 292030 });
    await run(host, 3000);
    assert.match(text(g), /XeSS version/);
    assert.doesNotMatch(text(g), /power profile/);
    await host.launchGame(570);
    await run(host, 30_000, 5000);
    await host.stopGame(570);
    await run(host, 5000);
    const sys = host.calls.filter((c) => c.method.startsWith("system.") && c.method !== "system.info");
    assert.deepEqual(sys.map((c) => c.method), [], "only system.info on another device");
    assert.deepEqual(hwWrites(host), []);
    assert.deepEqual(host.problems, []);
  } finally {
    await host.stop();
  }
});

test("Kernel tab only on CachyOS; platform line (B2, B3)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ device: { os: { id: "bazzite", name: "Bazzite", version: "43" }, kernel: "6.17.7-ba01.fc43.x86_64" } }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Bazzite 43 · Linux 6\.17\.7/);
    const p = await open(host, "panel", "main");
    assert.ok(!p.find({ type: "tabs" }).tabs.some((t) => t.id === "kernel"));
    await p.change({ type: "tabs" }, "battery");
    await host.settle();
    assert.match(text(p), /Linux 7\.4/, "fan and charge need Linux 7.4");
  } finally {
    await host.stop();
  }
});
