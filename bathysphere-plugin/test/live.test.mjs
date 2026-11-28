// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Live readouts only while a surface shows them, the summaries in closed headers, power tips while
// playing, the device check and the 60 s measurement (A4, A11, C24, C25, C35–C37, C39, C40).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clean, open, OXP3_DEVICE, oxp3Fixtures, panelTab, POWER_ON, run, start, text } from "./fixtures.mjs";

const reads = (host) => host.callsTo("system.sensors.read");

test("live readouts: about one read a second while shown, GPU clocks only on the panel, none when closed (C39, A11)", async () => {
  const host = await start();
  try {
    const q = await open(host, "quickAccessTab", "qam");
    await run(host, 5000, 1000);
    const n = reads(host).length;
    assert.ok(n >= 4 && n <= 7, `${n} reads in 5 s`);
    assert.ok(reads(host).every((c) => c.params.gpuClocks !== true));
    assert.match(q.find({ key: "g-live" }).subtitle, /^12\.4 W · 64 °C · GPU 55 % · 3 h 10 min left$/);
    const p = await panelTab(host, "power");
    await run(host, 3000, 1000);
    assert.equal(reads(host).at(-1).params.gpuClocks, true);
    assert.match(text(p), /Package power\n12\.4 W/);
    await p.close();
    await q.close();
    const m = reads(host).length;
    await run(host, 10_000, 1000);
    assert.equal(reads(host).length, m, "no reads with nothing open");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("GPU held back by the power limit; the group summaries while closed (C24, C40, A4)", async () => {
  const sensors = { ...OXP3_DEVICE.sensors, gpu: { busyPct: 99, reasons: ["pl1"] } };
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { sensors } }) });
  try {
    const p = await panelTab(host, "power");
    await run(host, 2000, 1000);
    assert.match(text(p), /GPU held back\nheld back by the power limit/);
    const q = await open(host, "quickAccessTab", "qam");
    await run(host, 2000, 1000);
    assert.match(q.find({ key: "g-cpu" }).subtitle, /Cap 100 %/);
    assert.match(q.find({ key: "g-battery" }).subtitle, /Fan Auto · Charges fully/);
    assert.match(q.find({ key: "g-xess" }).subtitle, /On \(20261031\)/);
    assert.match(q.find({ key: "g-fixes" }).subtitle, /3 applied/);
    assert.equal(q.find({ key: "g-cpu" }).children?.length ?? 0, 0, "closed groups draw nothing");
    await q.click({ key: "g-cpu" });
    await host.settle();
    assert.ok(host.state.storage.get("ui").groups.cpu, "the open state is remembered");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("power tips: 5 minutes of a light game, Use N W with Undo, Dismiss; off with the setting (C35)", async () => {
  const sensors = { ...OXP3_DEVICE.sensors, packageW: 9, gpu: { busyPct: 40, reasons: [] } };
  const host = await start({ fixtures: oxp3Fixtures({ storage: POWER_ON, device: { sensors } }) });
  try {
    await host.launchGame(570);
    await run(host, 7 * 60_000, 5000);
    assert.ok(reads(host).length >= 60, "sampled every 5 s with nothing open");
    const g = await open(host, "quickAccessTab", "qam");
    await run(host, 3000, 1000);
    assert.match(text(g), /Power tip/);
    const use = g.find({ label: /^Use \d+ W$/ });
    assert.ok(use, text(g));
    const w = Number(/\d+/.exec(use.label)[0]);
    assert.ok(w < 17);
    await g.click(use.label);
    await run(host, 1000);
    assert.equal(host.callsTo("system.tdp.set").at(-1).params.watts, w);
    await g.click("Undo: back to 17 W");
    await run(host, 1000);
    assert.equal(host.callsTo("system.tdp.set").at(-1).params.watts, 17);
    await g.click("Dismiss");
    await run(host, 1000);
    assert.ok(host.state.storage.get("advisor").dismissed["570"]);
    assert.doesNotMatch(text(g), /Power tip\n/);
    await g.close();
    await host.setSetting("powerTips", false);
    await host.settle();
    const n = reads(host).length;
    await run(host, 60_000, 5000);
    assert.equal(reads(host).length, n, "no sampling with tips off");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("device check: each control a step, read back, put back, ≥ 500 ms apart; refused while a game runs (C36)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ dialogs: { confirm: [true] } }) });
  try {
    const p = await panelTab(host, "power");
    await p.click("Check this device");
    await run(host, 40_000, 500);
    const st = host.state.storage.get("selftest").test;
    assert.ok(st, "the result is kept");
    assert.ok(st.probes.length >= 5);
    const tried = st.probes.filter((x) => x.outcome !== "skipped");
    assert.ok(tried.length >= 5 && tried.every((x) => x.outcome === "ok"), JSON.stringify(st.probes));
    assert.ok(st.probes.filter((x) => x.outcome === "skipped").every((x) => /confirm/.test(x.why)), "fan and charging need Home's confirm");
    const sets = host.calls.filter((c) => /^system\.(tdp|boost|gpu\.range|cpuLimits|socBalance|epp)\.set$/.test(c.method));
    for (let i = 1; i < sets.length; i++) {
      if (sets[i].method === sets[i - 1].method) assert.ok(sets[i].at - sets[i - 1].at >= 500, `${sets[i].method} twice within 500 ms`);
    }
    assert.equal(host.state.knobs.tdp.watts, 17, "put back");
    assert.equal(host.state.knobs.boost.mode, "firmware");
    assert.match(text(p), /Device check\n\d+ of \d+ work/);
    await host.launchGame(570);
    await host.settle();
    await p.click("Check this device");
    await host.settle();
    assert.equal(host.dialogs.log.at(-1).request.kind, "details");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("measure 60 s: idle on battery, one result kept (C37)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "power");
    await p.click("Measure idle power for 60 s");
    await run(host, 65_000, 1000);
    const m = host.state.storage.get("selftest").measures;
    assert.equal(m.length, 1);
    assert.equal(m[0].avgPackageW, 12.4);
    assert.match(text(p), /Idle on battery: 12\.4 W average/);
    clean(host);
  } finally {
    await host.stop();
  }
});
