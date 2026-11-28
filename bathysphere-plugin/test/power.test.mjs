// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Power control through the hardware helper and Steam: the first-use confirm, rules written to
// system.profiles, refusal while another program changes the limits, off restoring the defaults,
// Steam's sustained power, boost and GPU range, presets with Undo, game and plugged-in profiles,
// low battery, reset, re-reads after resume (C1–C5, C15–C17, C19, C20, C22, C28, C29, C33, C34, C41).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrokerError } from "../.bathysphere/packages/fake-host/dist/index.js";
import { POWER_ON, clean, open, oxp3Fixtures, panelTab, run, start, text } from "./fixtures.mjs";

const rules = (host) => host.state.profiles.rules;
const rule = (host, id) => rules(host).find((r) => r.id === id);
const lastSet = (host, method) => host.callsTo(method).at(-1)?.params;

test("first use confirms, writes the rules; off clears them and releases the knobs (C1, C41)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Power control" }, true);
    await run(host, 1000);
    assert.equal(host.callsTo("ui.confirm").length, 1);
    assert.equal(host.callsTo("ui.confirm")[0].params.title, "Turn on power control?");
    assert.deepEqual(rules(host), [{ id: "low", when: { power: "battery", batteryBelow: 20 }, set: { boost: { mode: "manual", watts: 15 }, epp: { all: "balance_power" } } }]);
    assert.match(text(p), /Power control: on/);
    await p.change({ label: "Power control" }, false);
    await run(host, 1000);
    assert.equal(host.callsTo("system.profiles.clear").length, 1);
    assert.deepEqual(host.callsTo("system.hardware.release").at(-1).params.knobs.sort(), ["boost", "chargeBehaviour", "cpuLimits", "energy", "epp", "fan", "governor", "gpuRange", "socBalance"]);
    assert.deepEqual(rules(host), []);
    assert.equal(host.callsTo("system.tdp.set").length, 0, "sustained power stays Steam's");
    await p.change({ label: "Power control" }, true);
    await run(host, 1000);
    assert.equal(host.callsTo("ui.confirm").length, 1, "the confirm is asked once");
    assert.equal(rules(host).length, 1);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("declining the first confirm changes nothing (A6)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [false] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Power control" }, true);
    await run(host, 1000);
    assert.equal(host.callsTo("system.profiles.set").length, 0);
    assert.match(text(p), /Power control: off/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("refused while another program changes the power limits (C22)", async () => {
  const thermald = { id: "thermald", name: "thermald", kind: "blocks", unit: "thermald.service", active: true, how: "sudo systemctl disable --now thermald" };
  const host = await start({ fixtures: oxp3Fixtures({ device: { conflicts: [thermald] }, dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Power control" }, true);
    await run(host, 1000);
    assert.equal(host.callsTo("ui.confirm").length, 0);
    assert.equal(host.callsTo("system.profiles.set").length, 0);
    assert.match(text(p), /Turn off Thermal daemon first/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("sustained power: one Steam write after the slider settles; a read-back failure shows (C2, C28)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Sustained power" }, 20);
    await p.change({ label: "Sustained power" }, 21);
    await p.change({ label: "Sustained power" }, 22);
    await run(host, 1000);
    assert.deepEqual(host.callsTo("system.tdp.set").map((c) => c.params.watts), [22]);
    assert.equal(host.state.knobs.tdp.watts, 22);
    host.state.readBack.set("tdp", "Another Daemon");
    await p.change({ label: "Sustained power" }, 15);
    await run(host, 1000);
    assert.equal(host.callsTo("system.tdp.set").length, 2);
    assert.match(text(p), /Another Daemon/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("sustained power capped on battery shows the effective value (C2)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { knobs: { tdp: { watts: 30, min: 5, max: 35, capped: "battery", effective: 25 } } } }) });
  try {
    const p = await panelTab(host, "power");
    assert.match(text(p), /Runs at 25 W on battery/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("boost, follow and the GPU range go into the default rule (C3, C4, C5)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const p = await panelTab(host, "power");
    await run(host, 1500);
    await p.change({ label: "Boost power" }, 25);
    await p.change({ label: "GPU maximum speed" }, 1800);
    await run(host, 2500);
    assert.deepEqual(rule(host, "default").set, { boost: { mode: "manual", watts: 25 }, gpuRange: { minMhz: 100, maxMhz: 1800 } });
    await p.change({ label: "Steadier fps after loads" }, true);
    await run(host, 2500);
    assert.equal(rule(host, "default").set.boost.mode, "follow");
    assert.deepEqual(rule(host, "ac").when, { power: "ac" }, "follow needs a plugged-in offset");
    assert.ok(rule(host, "ac").set.boost.offsetW > rule(host, "default").set.boost.offsetW);
    await p.change({ label: "GPU minimum speed" }, 600);
    await run(host, 2500);
    assert.deepEqual(rule(host, "default").set.gpuRange, { minMhz: 600, maxMhz: 1800 });
    assert.ok(host.callsTo("system.profiles.set").length <= 4, "edits are batched into few writes");
    host.dialogs.confirm(true);
    await p.click("Reset to device defaults");
    await run(host, 2500);
    assert.equal(rule(host, "default"), undefined, "an empty default needs no rule (C29)");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Battery preset: Steam's knobs now, the rule part, Undo for 30 s (C33)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    await q.change({ type: "chips" }, "battery");
    await run(host, 3000);
    assert.equal(lastSet(host, "system.tdp.set").watts, 10);
    assert.equal(lastSet(host, "system.cpuBoost.set").enabled, false);
    assert.equal(lastSet(host, "system.gpu.powerProfile.set").profile, "power_saving");
    assert.deepEqual(rule(host, "default").set.boost, { mode: "manual", watts: 15 });
    assert.deepEqual(rule(host, "default").set.epp, { all: "balance_power" });
    const undo = q.find({ label: /^Undo/ });
    assert.ok(undo, "an Undo row");
    await q.click({ label: /^Undo/ });
    await run(host, 3000);
    assert.equal(lastSet(host, "system.tdp.set").watts, 17);
    assert.equal(lastSet(host, "system.cpuBoost.set").enabled, true);
    assert.equal(lastSet(host, "system.gpu.powerProfile.set").profile, "base");
    assert.equal(rule(host, "default"), undefined);
    await q.change({ type: "chips" }, "max");
    await run(host, 3000);
    assert.equal(lastSet(host, "system.tdp.set").watts, 35);
    assert.ok(q.find({ label: /^Undo/ }));
    await run(host, 31_000, 1000);
    assert.equal(q.find({ label: /^Undo/ }), undefined, "the Undo row is gone after 30 s");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a game profile, plugged-in values and low battery for games (C15, C16, C17, C19, C34)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "New profile for a game" }, "570");
    await run(host, 2000);
    assert.ok(rule(host, "app-570"), "a rule for Dota 2");
    assert.deepEqual(rule(host, "app-570").when, { app: 570 });
    assert.match(text(p), /Dota 2/);
    await p.change({ label: "Boost power" }, 30);
    await run(host, 2000);
    assert.deepEqual(rule(host, "app-570").set.boost, { mode: "manual", watts: 30 });
    await p.change({ label: "Different settings when plugged in" }, true);
    await run(host, 2000);
    assert.ok(rule(host, "app-570-ac"));
    assert.deepEqual(rule(host, "app-570-ac").when, { app: 570, power: "ac" });
    await p.change({ label: "Low battery level" }, 30);
    await p.change({ label: "Also for games with their own profile" }, true);
    await run(host, 2000);
    assert.deepEqual(rule(host, "low").when, { power: "battery", batteryBelow: 30 }, "the low values end on the charger (power.py _low_eval)");
    assert.deepEqual(rule(host, "app-570-low").when, { app: 570, power: "battery", batteryBelow: 30 });
    assert.equal(rule(host, "app-570-low").set.boost.watts, 15, "low battery never raises the game's boost");
    await host.launchGame(570);
    await run(host, 1000);
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Dota 2/, "the Power summary names the game's profile");
    await p.change({ label: "Per-game profiles" }, false);
    await run(host, 2000);
    assert.ok(!rules(host).some((r) => r.id.startsWith("app-")), "per-game off drops the game rules");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("resume and AC changes re-read; the plugin never rewrites what hostd re-applies (C20)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    await panelTab(host, "power");
    await run(host, 2000);
    const sets = host.callsTo("system.profiles.set").length;
    const gets = host.callsTo("system.hardware.get").length;
    await host.events.emit("session.resume", {});
    await host.events.emit("power.ac", { online: true });
    await run(host, 2000);
    assert.ok(host.callsTo("system.hardware.get").length > gets);
    assert.equal(host.callsTo("system.profiles.set").length, sets);
    clean(host);
  } finally {
    await host.stop();
  }
});

// ---- review findings -------------------------------------------------------------------------------

const thermald = { id: "thermald", name: "thermald", kind: "blocks", unit: "thermald.service", active: true, how: "sudo systemctl disable --now thermald" };
/** profiles.get as hostd answers it, with the rule that won (the fake host only picks one when rules are written). */
const activeRule = (rule) => ({ "system.profiles.get": (_p, ctx) => ({ ...structuredClone(ctx.state.profiles), active: { rule, failed: [] } }) });

test("a blocking program that starts after power control is on: no false 'paused', the profiles keep applying", async () => {
  const device = { conflicts: [] };
  const host = await start({ fixtures: oxp3Fixtures({ storage: { ...POWER_ON, ui: { v: 1, powerConfirmed: true, groups: { power: false } } }, device }) });
  try {
    await open(host, "quickAccessTab", "qam");
    host.state.device.conflicts = [thermald];
    await run(host, 61_000, 5000);
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Another program changes power limits\nThermal daemon: your limits may not hold/);
    assert.doesNotMatch(text(q), /paused/i);
    const p = await panelTab(host, "power");
    assert.doesNotMatch(text(p), /paused/i);
    assert.match(text(p), /Power control: on/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("power control is not turned on while the other power programs cannot be read", async () => {
  const responders = { "system.power.conflicts": () => { throw new BrokerError("EINTERNAL", "systemd did not answer"); } };
  const host = await start({ fixtures: oxp3Fixtures({ device: { conflicts: [thermald] }, storage: { ui: { v: 1, powerConfirmed: true } }, responders }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Power control" }, true);
    await run(host, 1000);
    assert.equal(host.state.storage.get("power")?.enabled ?? false, false);
    assert.equal(host.callsTo("system.profiles.set").length, 0);
    assert.match(text(p), /Could not check for other power programs/);
    assert.match(text(p), /Other power programs: not read/);
    delete responders["system.power.conflicts"];
    host.state.device.conflicts = [];
    await p.click("Try again");
    await run(host, 1000);
    assert.doesNotMatch(text(p), /Could not check for other power programs/);
    assert.equal(host.state.storage.get("power").enabled, true);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("while a game's low-battery rule runs, the quick sliders edit Default's low values (quickgroups.ts editedSlot)", async () => {
  const storage = { power: { v: 1, enabled: true, options: { lowBattery: true, lowGames: true, lowPct: 20 }, profiles: { default: { main: {} }, 570: { name: "Dota 2", main: { boostW: 30 }, at: 1 } } }, ui: { v: 1, powerConfirmed: true } };
  const host = await start({ fixtures: oxp3Fixtures({ storage, device: { battery: { percent: 15, charging: false, ac: false } }, responders: activeRule("app-570-low") }) });
  try {
    await host.launchGame(570);
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Edits: Default, low battery/);
    await q.change({ label: "Boost power" }, 20);
    await run(host, 2500);
    const stored = host.state.storage.get("power");
    assert.equal(stored.profiles.default.low.boostW, 20, "Default's low values");
    assert.equal(stored.profiles["570"].low ?? null, null);
    assert.equal(rule(host, "low").set.boost.watts, 20);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Low battery rows: while the low values run, and while a game's own profile holds them back (power.ts lowLine)", async () => {
  const battery = { percent: 15, charging: false, ac: false };
  let host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { battery }, responders: activeRule("low") }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Low battery\n15 %: saving power until 22 % or plugged in/);
    const p = await panelTab(host, "power");
    assert.match(text(p), /Low battery\n15 %: saving power until 22 %/);
    clean(host);
  } finally {
    await host.stop();
  }
  const storage = { power: { v: 1, enabled: true, profiles: { default: { main: {} }, 570: { name: "Dota 2", main: { boostW: 30 }, at: 1 } } }, ui: { v: 1, powerConfirmed: true } };
  host = await start({ fixtures: oxp3Fixtures({ storage, device: { battery }, responders: activeRule("app-570") }) });
  try {
    await host.launchGame(570);
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Low battery\n15 %: Dota 2 keeps its own profile/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("70 game profiles: the Power tab still renders; Default first, at most 64 choices, the edited one among them", async () => {
  const profiles = { default: { main: {} } };
  for (let i = 0; i < 70; i++) profiles[String(1000 + i)] = { name: `Game ${String(i).padStart(2, "0")}`, main: {}, at: i };
  const host = await start({ fixtures: oxp3Fixtures({ storage: { power: { v: 1, enabled: true, profiles }, ui: { v: 1, powerConfirmed: true, tab: "power" } } }) });
  try {
    const p = await panelTab(host, "power");
    const sel = p.find({ label: "Profile to edit" });
    assert.ok(sel, text(p).slice(0, 300));
    assert.equal(sel.options[0].value, "default");
    assert.equal(sel.options[0].label, "Default");
    assert.ok(sel.options.length <= 64);
    assert.equal(sel.options[1].label, "Game 00", "games by name");
    await p.change({ label: "Profile to edit" }, sel.options[63].value);
    await host.settle();
    assert.equal(p.find({ label: "Profile to edit" }).value, sel.options[63].value);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("rule upkeep: Re-apply when hostd's rules differ, Clear when power control is off, Retry after a failed write", async () => {
  const stale = [{ id: "default", when: {}, set: { fan: "auto" } }];
  const responders = {};
  let host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, responders }) });
  try {
    host.state.profiles = { rules: stale, active: { rule: "default", failed: [] } };
    const p = await panelTab(host, "power");
    await p.click("Re-apply your power profiles");
    await run(host, 2000);
    assert.equal(rules(host).find((r) => r.id === "default"), undefined, "the stored profiles' rules (an empty Default needs none)");
    assert.ok(rule(host, "low"));
    responders["system.profiles.set"] = () => { throw new BrokerError("EINTERNAL", "hostd could not store the rules"); };
    await p.change({ label: "Boost power" }, 25);
    await run(host, 2500);
    assert.match(text(p), /Power profiles: not saved/);
    delete responders["system.profiles.set"];
    // the queue keeps profiles.set 1 s apart on the host's clock: the handler waits for it
    const retry = p.click({ type: "button", label: "Retry" });
    await run(host, 2000);
    await retry;
    assert.doesNotMatch(text(p), /Power profiles: not saved/);
    assert.deepEqual(rule(host, "default").set.boost, { mode: "manual", watts: 25 });
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start();
  try {
    host.state.profiles = { rules: stale, active: { rule: "default", failed: [] } };
    const p = await panelTab(host, "power");
    const clear = p.click("Clear the stored power rules");
    await run(host, 12_000, 1000);
    await clear;
    assert.equal(host.callsTo("system.profiles.clear").length, 1);
    assert.deepEqual(rules(host), []);
    clean(host);
  } finally {
    await host.stop();
  }
});
