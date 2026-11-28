// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Other power programs: rows with their "Run this yourself" steps, Turn off all, Check again,
// "turned off" records with the way back, came back after a fix, "I've handled it" for hhd and
// Steam TDP remotes, Decky leftovers (D1–D5, D7–D11).
import assert from "node:assert/strict";
import { test } from "node:test";
import { findAll } from "../.bathysphere/packages/fake-host/dist/index.js";
import { clean, open, oxp3Fixtures, panelTab, run, start, text } from "./fixtures.mjs";

const svc = (id, name, kind = "blocks") => ({ id, name, kind, unit: `${id}.service`, active: true, how: `sudo systemctl disable --now ${id}` });
const cards = (s) => findAll(s.tree, { type: "instructions" }).map((n) => `${n.id}:${(n.steps ?? []).join(",")}`);

test("conflict rows, their steps, Turn off all; Check again records what was turned off (D1–D5, D9, D10)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ device: { conflicts: [svc("thermald", "thermald"), svc("power-profiles-daemon", "power-profiles-daemon", "cpu")] } }) });
  try {
    const p = await panelTab(host, "power");
    assert.match(text(p), /Thermal daemon/);
    assert.match(text(p), /Power Profiles/);
    const c = cards(p);
    assert.ok(c.includes("power-off:0"), c.join(" "));
    assert.ok(c.includes("power-off:1"));
    assert.ok(c.includes("power-off:0,1"), "Turn off all (2)");
    for (const x of host.state.device.conflicts) x.active = false;
    await p.click("Check again");
    await run(host, 500);
    assert.doesNotMatch(text(p), /Power Profiles\nIt also|Thermal daemon\n(?!.*turned off)/);
    assert.match(text(p), /Thermal daemon: turned off/);
    assert.ok(cards(p).includes("power-on:0"), "the way back");
    assert.ok(cards(p).includes("power-on:1"));
    assert.ok(host.state.storage.get("conflicts").off.thermald, "kept across restarts");
    host.state.device.conflicts[0].active = true;
    await p.click("Check again");
    await run(host, 500);
    assert.match(text(p), /Thermal daemon\nIt started again/, "came back after the fix (D8)");
    await p.click("Forget this");
    await run(host, 500);
    assert.equal(host.state.storage.get("conflicts").off["power-profiles-daemon"] === undefined, true);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("hhd and a Steam TDP remote can be marked as handled; they then stop blocking (D7)", async () => {
  const hhd = { ...svc("hhd", "Handheld Daemon"), how: "Turn off its TDP control" };
  const host = await start({ fixtures: oxp3Fixtures({ device: { conflicts: [hhd] }, dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    assert.ok(cards(p).includes("hhd-tdp:"));
    await p.change({ label: "Power control" }, true);
    await run(host, 500);
    assert.equal(host.callsTo("system.profiles.set").length, 0, "blocked first");
    await p.change({ label: "I've handled it" }, true);
    await run(host, 500);
    assert.deepEqual(host.state.storage.get("power").ignored, ["hhd"]);
    assert.match(text(p), /Marked as handled/);
    await p.change({ label: "Power control" }, true);
    await run(host, 1000);
    assert.equal(host.callsTo("system.profiles.set").length, 1);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Decky power plugins: the leftovers card with the plugin's step (D11)", async () => {
  const decky = { id: "decky-simpledeckytdp", name: "SimpleDeckyTDP", kind: "blocks", active: true, how: "Remove it in Decky" };
  const host = await start({ fixtures: oxp3Fixtures({ device: { conflicts: [decky] } }) });
  try {
    const p = await panelTab(host, "power");
    assert.ok(cards(p).includes("decky-leftovers:0,1"));
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /SimpleDeckyTDP/, "a blocking program is an alert in Quick Access, even with the group closed");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("re-reads every minute while a surface is open, never with none (D1, A11)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "power");
    const n = host.callsTo("system.power.conflicts").length;
    await run(host, 125_000, 5000);
    assert.ok(host.callsTo("system.power.conflicts").length >= n + 2);
    await p.close();
    const m = host.callsTo("system.power.conflicts").length;
    await run(host, 125_000, 5000);
    assert.equal(host.callsTo("system.power.conflicts").length, m);
    clean(host);
  } finally {
    await host.stop();
  }
});
