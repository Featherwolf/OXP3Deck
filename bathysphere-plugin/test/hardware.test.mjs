// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// The hardware helper and the knobs around power control: helper missing or off, the plugged-in
// limit file, knob status, leases held by other plugins, overridden knobs and Take control, rule
// failures, the CPU controls, the fan and charging with their host confirms (C7–C14, C18, C21,
// C25–C28, D12, E1–E9, K1–K4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrokerError } from "../.bathysphere/packages/fake-host/dist/index.js";
import { POWER_ON, clean, hardwareState, open, oxp3Fixtures, panelTab, run, start, text } from "./fixtures.mjs";

const rule = (host, id) => host.state.profiles.rules.find((r) => r.id === id);

test("no hardware helper: the install card, no helper controls (K1)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { provider: null, knobs: { boost: null, epp: null, cpuLimits: null, socBalance: null, gpuRange: null, fan: null, chargeBehaviour: null } } }) });
  try {
    const p = await panelTab(host, "power");
    assert.match(text(p), /hardware helper is not installed/);
    assert.ok(p.find((n) => n.type === "instructions" && n.id === "hw-install"));
    assert.equal(p.find({ label: "Boost power" }), undefined);
    assert.equal(p.find({ label: "GPU maximum speed" }), undefined);
    assert.ok(p.find({ label: "Sustained power" }), "Steam's sustained power still works");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("helper turned off: its state and the card's step to turn it on (K1)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ device: { provider: { name: "oxp3-hw", version: "0.1.0", device: "onexplayer-3", api: "1", state: "disabled" } } }) });
  try {
    const p = await panelTab(host, "power");
    assert.match(text(p), /Hardware helper: disabled/);
    const card = p.find((n) => n.type === "instructions" && n.id === "hw-stop");
    assert.deepEqual(card.steps, [1]);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("the plugged-in limit from /etc/oxp3-hw/limits.toml (C18)", async () => {
  const sys = { "/etc/oxp3-hw/limits.toml": "# local limits\nsustained_ac_max_w = 40\n", "/var/lib/oxp3-tool/state.json": "{}" };
  const host = await start({ fixtures: oxp3Fixtures({ systemFiles: sys }) });
  try {
    const p = await panelTab(host, "power");
    assert.match(text(p), /limits\.toml allows 40 W plugged in/);
    assert.ok(p.find((n) => n.type === "instructions" && n.id === "hw-ac-limit"));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("knob status on the Setup tab: backend, owner, lease holder (K2, K3)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ responders: { "system.hardware.get": (_p, ctx) => hardwareState(ctx.state, { fan: { owner: "other", lease: "Fan Plugin" } }) } }) });
  try {
    const p = await panelTab(host, "setup");
    assert.match(text(p), /Fan Plugin/);
    assert.match(text(p), /tdp: sustained power\nSteam · steamos-manager/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a knob leased by another plugin: power control says who holds it (K3)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { leases: { boost: "Other Plugin" } } }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Boost power" }, 25);
    await run(host, 2500);
    assert.equal(host.callsTo("system.profiles.set").at(-1).error?.code, "EBUSY");
    assert.match(text(p), /Other Plugin/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("something else changed boost: a red row, Take control re-sets the rule's value (C21)", async () => {
  const responders = {};
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, responders }) });
  try {
    const p = await panelTab(host, "power");
    await p.change({ label: "Boost power" }, 25);
    await run(host, 2500);
    responders["system.hardware.get"] = (_p, ctx) => hardwareState(ctx.state, { boost: { owner: "self", overridden: true } });
    await host.events.emit("hardware.changed", { knob: "boost", reason: "overridden" });
    await run(host, 3000);
    assert.match(text(p), /Something else changed boost power/);
    await p.click("Take control of boost power");
    await run(host, 1000);
    assert.deepEqual(host.callsTo("system.boost.set").at(-1).params, { mode: "manual", watts: 25 });
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a rule value the helper refused shows under Power (C28)", async () => {
  const responders = {};
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, responders }) });
  try {
    const p = await panelTab(host, "power");
    await run(host, 2000);
    responders["system.profiles.get"] = (_p, ctx) => ({ ...structuredClone(ctx.state.profiles), active: { rule: "low", failed: [{ knob: "boost", code: "EBUSY", message: "not applied: PL2=15 (locked by firmware)" }] } });
    await host.events.emit("hardware.changed", { knob: "boost", reason: "rule" });
    await run(host, 3000);
    assert.match(text(p), /boost power did not apply\nDid not take/);
    const row = p.find({ label: "boost power did not apply" });
    assert.match(row.details.body, /PL2=15/, "the helper's words behind Details");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("CPU tab: energy preference, cap, minimum plugged in, balance, per-core caps (C7, C9–C14, C25)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const p = await panelTab(host, "cpu");
    assert.match(text(p), /CPU now/);
    await p.change({ label: "Energy preference" }, "power");
    await p.change({ label: "CPU speed cap" }, 70);
    await run(host, 2500);
    assert.deepEqual(rule(host, "default").set.epp, { all: "power" });
    assert.deepEqual(rule(host, "default").set.cpuLimits, { maxPerfPct: 70 });
    await p.change({ label: "CPU minimum speed (plugged in)" }, 40);
    await p.change({ label: "CPU vs GPU balance" }, 4);
    await run(host, 2500);
    assert.deepEqual(rule(host, "ac").set.cpuLimits, { maxPerfPct: 70, minPerfPct: 40 });
    assert.deepEqual(rule(host, "default").set.socBalance, { balance: 4, offset: 0 });
    await p.change({ label: "Show advanced CPU options" }, true);
    await run(host, 500);
    await p.change({ label: "Performance cores: energy preference" }, "performance");
    await run(host, 2500);
    assert.deepEqual(rule(host, "default").set.epp, { p: "performance", e: "power", lpe: "power" });
    host.dialogs.confirm(true);
    await p.change({ label: "Low-power cores: maximum" }, 1200);
    await run(host, 2500);
    assert.equal(host.callsTo("ui.confirm").at(-1).params.title, "Use per-core caps?");
    assert.deepEqual(rule(host, "default").set.cpuLimits, { coreTypeMaxMhz: { lpe: 1200 } });
    await p.change({ label: "CPU boost" }, false);
    await run(host, 1000);
    assert.deepEqual(host.callsTo("system.cpuBoost.set").at(-1).params, { enabled: false });
    clean(host);
  } finally {
    await host.stop();
  }
});

test("CPU warnings: governor performance, EPP locked by power-profiles-daemon (C26, D12)", async () => {
  const ppd = { id: "power-profiles-daemon", name: "power-profiles-daemon", kind: "cpu", unit: "power-profiles-daemon.service", active: true, how: "x" };
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { conflicts: [ppd], ppdRunning: true, knobs: { governor: { governor: "performance", available: ["performance", "powersave"] }, energy: { profile: "balanced", available: ["power-saver", "balanced", "performance"] } } } }) });
  try {
    const p = await panelTab(host, "cpu");
    assert.match(text(p), /CPU speed policy is Performance/);
    assert.match(text(p), /Power Profiles/);
    assert.ok(p.find({ label: "Energy mode" }), "the energy mode replaces the per-core preference");
    assert.ok(p.find((n) => n.type === "instructions" && n.id === "scx-mode"), "the scheduler mode card on CachyOS (E9)");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("fan per profile: the host confirm in Home, declined, and from Steam's Quick Access (E1, K4)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, dialogs: { hardware: [false, true] } }) });
  try {
    const p = await panelTab(host, "battery");
    await p.change({ label: "Fan" }, "quiet");
    await run(host, 2500);
    assert.equal(host.callsTo("system.profiles.set").at(-1).error?.code, "EPERM");
    assert.match(text(p), /Not changed/);
    await p.change({ label: "Fan" }, "max");
    await run(host, 2500);
    assert.equal(rule(host, "default").set.fan, "max");
    assert.equal(host.state.knobs.fan.mode, "max");
    clean(host);
  } finally {
    await host.stop();
  }
  const steam = await start({ surfacesIn: "steam", fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const q = await open(steam, "quickAccessTab", "qam");
    await q.click({ key: "g-battery" }).catch(() => {});
    const p = await panelTab(steam, "battery");
    await p.change({ label: "Fan" }, "quiet");
    await run(steam, 2500);
    assert.equal(steam.callsTo("system.profiles.set").at(-1).error?.code, "EBUSY");
    assert.match(text(p), /Bathysphere Home/);
    clean(steam);
  } finally {
    await steam.stop();
  }
});

test("the helper put the fan back to Auto: why (E2, E3)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON }) });
  try {
    const p = await panelTab(host, "battery");
    await host.events.emit("hardware.changed", { knob: "fan", reason: "reverted-temperature" });
    await run(host, 1000);
    assert.match(text(p), /Fan went back to Auto\nBecause the CPU reached 90 °C/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("charge limit: confirm below 80 %, one write per 10 s with the newest value waiting (E5)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { hardware: [true] } }) });
  try {
    const p = await panelTab(host, "battery");
    await p.change({ label: "Charge limit" }, 70);
    await run(host, 1000);
    assert.deepEqual(host.callsTo("system.chargeLimit.set").map((c) => c.params.percent), [70]);
    assert.equal(host.dialogs.log.filter((d) => d.request.kind === "hardware").length, 1);
    await p.change({ label: "Charge limit" }, 85);
    await run(host, 1000);
    await p.change({ label: "Charge limit" }, 90);
    await run(host, 1000);
    assert.equal(host.callsTo("system.chargeLimit.set").length, 1, "the next write waits for the 10 s window");
    await run(host, 10_000);
    assert.deepEqual(host.callsTo("system.chargeLimit.set").map((c) => c.params.percent), [70, 90]);
    assert.ok(host.callsTo("system.chargeLimit.set").every((c) => !c.error));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("run from charger: confirm, the value in every rule, kept when power control goes off (E6)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, dialogs: { hardware: [true] } }) });
  try {
    const p = await panelTab(host, "battery");
    await p.change({ label: "Run from charger" }, true);
    await run(host, 2500);
    assert.equal(host.state.knobs.chargeBehaviour.value, "inhibit-charge-awake");
    assert.ok(host.state.profiles.rules.every((r) => r.set.chargeBehaviour === "inhibit-charge-awake"));
    await p.change({ type: "tabs" }, "power");
    await host.settle();
    // the charging pause is set again after the release, in its 10 s window: the handler waits for it
    const off = p.change({ label: "Power control" }, false);
    await run(host, 12_000, 1000);
    await off;
    assert.ok(!host.callsTo("system.hardware.release").at(-1).params.knobs.includes("chargeBehaviour"));
    assert.equal(host.state.knobs.chargeBehaviour.value, "inhibit-charge-awake");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("something else changed the charge limit: a row and Take control (E7)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { hardware: [true] } }) });
  try {
    const p = await panelTab(host, "battery");
    await p.change({ label: "Charge limit" }, 90);
    await run(host, 1000);
    host.state.knobs.chargeLimit.percent = 60;
    await host.events.emit("hardware.changed", { knob: "chargeLimit", reason: "external" });
    await run(host, 3000);
    assert.match(text(p), /Something else changed the charge limit/);
    const take = p.click("Take control");
    await run(host, 12_000, 1000);
    await take;
    assert.equal(host.callsTo("system.chargeLimit.set").at(-1).params.percent, 90);
    clean(host);
  } finally {
    await host.stop();
  }
});

// ---- review findings -------------------------------------------------------------------------------

test("the fan with power control off: set directly (PowerControls.tsx ExtrasRows, also while power control is off)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { hardware: [true] } }) });
  try {
    const p = await panelTab(host, "battery");
    assert.ok(p.find({ label: "Fan" }), "a Fan select, not only a note");
    await p.change({ label: "Fan" }, "quiet");
    await run(host, 1000);
    assert.deepEqual(host.callsTo("system.fan.set").at(-1).params, { mode: "quiet" });
    assert.equal(host.state.knobs.fan.mode, "quiet");
    assert.equal(host.callsTo("system.profiles.set").length, 0, "no rules while power control is off");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Take control of every knob the helper reports overridden (C21): each knob's own set", async () => {
  const responders = {};
  const fixtures = oxp3Fixtures({ storage: POWER_ON, dialogs: { hardware: [true, true, true] }, responders, device: { knobs: { energy: { profile: "balanced", available: ["power-saver", "balanced", "performance"] } } } });
  const host = await start({ fixtures });
  try {
    const over = Object.fromEntries(["tdp", "boost", "gpuRange", "epp", "cpuLimits", "socBalance", "fan", "chargeBehaviour", "energy"].map((k) => [k, { overridden: true, ...(k === "energy" ? { available: true, backend: "ppd" } : {}) }]));
    responders["system.hardware.get"] = (_p, ctx) => hardwareState(ctx.state, over);
    const want = {
      power: [["sustained power", "system.tdp.set"], ["boost power", "system.boost.set"], ["the GPU speed range", "system.gpu.range.set"]],
      cpu: [["energy preference", "system.epp.set"], ["the CPU limits", "system.cpuLimits.set"], ["the CPU vs GPU balance", "system.socBalance.set"], ["the energy mode", "system.energy.set"]],
      battery: [["the fan", "system.fan.set"], ["Run from charger", "system.chargeBehaviour.set"]],
    };
    for (const [tab, knobs] of Object.entries(want)) {
      const p = await panelTab(host, tab);
      for (const [name, method] of knobs) {
        const before = host.callsTo(method).length;
        const click = p.click(`Take control of ${name}`);
        await run(host, 11_000, 1000);
        await click;
        assert.equal(host.callsTo(method).length, before + 1, `Take control of ${name} calls ${method}`);
        assert.ok(!host.callsTo(method).at(-1).error, `${method}: ${host.callsTo(method).at(-1).error?.message}`);
      }
    }
    clean(host);
  } finally {
    await host.stop();
  }
});

test("hardware reads that fail show why, with Retry (Quick.tsx Problem); one knob's failure says which", async () => {
  const responders = { "system.hardware.get": () => { throw new BrokerError("EINTERNAL", "oxp3-hwd did not answer"); } };
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, responders }) });
  try {
    const p = await panelTab(host, "power");
    await run(host, 3000, 1000);
    assert.match(text(p), /Hardware: not read/);
    assert.ok(p.find({ type: "button", label: "Retry" }));
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Hardware: not read/);
    delete responders["system.hardware.get"];
    responders["system.tdp.get"] = () => { throw new BrokerError("EINTERNAL", "steamos-manager: D-Bus timeout"); };
    await p.click({ type: "button", label: "Retry" });
    await run(host, 3000, 1000);
    assert.doesNotMatch(text(p), /Hardware: not read/);
    assert.match(text(p), /sustained power: not read/);
    assert.equal(p.find({ label: "Sustained power" }), undefined);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("the device check stops when OXP3 Deck closes; what it could not put back is put back once a surface opens", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.click("Check this device");
    await host.settle();
    assert.equal(host.callsTo("system.tdp.set").at(-1).params.watts, 18, "the first step");
    await host.close("panel", "main");
    await run(host, 40_000, 500);
    assert.equal(host.state.knobs.tdp.watts, 18, "no surface: the put-back is refused (EPERM)");
    const sets = host.calls.filter((c) => /^system\.(boost|gpu\.range|cpuLimits|socBalance|epp)\.set$/.test(c.method));
    assert.equal(sets.length, 0, "no further steps once closed");
    const probes = host.state.storage.get("selftest").test.probes;
    assert.equal(probes[0].outcome, "not_restored");
    assert.ok(probes.slice(1, 6).every((x) => x.outcome === "skipped" && /closed/.test(x.why)), JSON.stringify(probes));
    const again = await panelTab(host, "power");
    assert.match(text(again), /The device check did not put everything back\nNot put back: Sustained power \(was 17 W\)/);
    await again.click("Put back");
    await run(host, 1000);
    assert.equal(host.state.knobs.tdp.watts, 17, "put back");
    assert.doesNotMatch(text(again), /did not put everything back/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("an owed put-back runs by itself within a minute while a surface is open", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.click("Check this device");
    await host.settle();
    await host.close("panel", "main");
    await run(host, 30_000, 500);
    assert.equal(host.state.knobs.tdp.watts, 18);
    await open(host, "quickAccessTab", "qam");
    await run(host, 61_000, 1000);
    assert.equal(host.state.knobs.tdp.watts, 17);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("power control on: a helper knob the check left changed is put back too (the rules alone need not re-apply it)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.click("Check this device");
    for (let i = 0; i < 100 && host.callsTo("system.boost.set").length === 0; i++) await host.advance(50);
    assert.equal(host.callsTo("system.boost.set").at(-1)?.params.mode, "manual", "the boost step's trial write");
    await host.close("panel", "main");
    await run(host, 40_000, 500);
    assert.equal(host.state.knobs.boost.mode, "manual", "left at the trial value: no surface for the put-back");
    await open(host, "quickAccessTab", "qam");
    await run(host, 61_000, 1000);
    assert.equal(host.state.knobs.boost.mode, "firmware", "put back once a surface is open");
    assert.equal(host.state.knobs.tdp.watts, 17);
    clean(host);
  } finally {
    await host.stop();
  }
});
