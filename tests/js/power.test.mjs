// Tests for src/power.ts. Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CORE_TYPES, EMPTY, FIELDS, minPctRange, POLL_STEPS, pollIndex, pollText, pollValue, RESET, toCaps, toPct, usesCaps,
  blockers, clampW, editSlot, effectiveLine, eppOptions, failedLines, fwValues, gpuNotches, idText, makeWriter,
  overriddenText, pl1Change, pl2Floor, profileLine, profileOrder, reasonText, shown, suspects, watts,
} from "../../src/power.ts";

// ---- fakes ---------------------------------------------------------------------------------------------------------

const fakeClock = () => {
  let t = 0;
  let next = 1;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      set: (fn, ms) => { const id = next++; pending.set(id, { fn, at: t + ms }); return id; },
      clear: (id) => { pending.delete(id); },
    },
    /** advance by ms, firing due timers in order */
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
};

const flushMicro = () => new Promise((r) => setImmediate(r));

/** send() that answers only when the test resolves it. */
const fakeSend = () => {
  const calls = [];
  const send = (key, slot, values) => new Promise((resolve) => { calls.push({ key, slot, values, resolve }); });
  return { calls, send };
};

const stateWith = (over = {}) => ({
  enabled: true,
  active: { key: "default", name: "Default", slot: "main", app: null, ac: false },
  values: { pl1_w: null, pl2_w: null, gpu_min_mhz: null, gpu_max_mhz: null, epp: null, turbo: null },
  applied_values: { pl1_w: 25, pl2_w: 52, gpu_min_mhz: 100, gpu_max_mhz: 2300, epp: "balance_performance", turbo: true },
  now: {
    pl1_w: 15, pl2_w: 25,
    zones: [
      { id: "intel-rapl:0", iface: "msr", name: "package-0", pl1_w: 15, pl2_w: 25, pl4_w: 160, boot_pl1_w: 25, boot_pl2_w: 52, pl1_base_w: 25, locked: [] },
      { id: "intel-rapl-mmio:0", iface: "mmio", name: "package-0", pl1_w: 15, pl2_w: 25, pl4_w: 160, boot_pl1_w: 35, boot_pl2_w: 52, pl1_base_w: 25, locked: [] },
    ],
    gpu: { min: 100, max: 2300, act: 1450, reasons: ["pl1"] },
    epp: "balance_performance", turbo: true, governor: "powersave",
  },
  range: { pl1_min: 5, pl1_max: 35, pl2_max: 52, pl1_max_battery: 35, pl1_max_ac: 40, extended_max: 52,
    gpu_min: 100, gpu_max: 2300, gpu_efficient: 900, spec: "oxp3" },
  overridden: null, blocked: null, cpu_blocked: null, last: null,
  ...over,
});

const answer = (state = stateWith()) => ({ ok: true, error: null, state, applied: null });

// ---- makeWriter ----------------------------------------------------------------------------------------------------

test("makeWriter: one trailing send 250 ms after the last write, merged", async () => {
  const c = fakeClock();
  const s = fakeSend();
  const w = makeWriter(s.send, { timers: c.timers, now: c.now });
  w.write("default", "main", { pl1_w: 10 });
  c.tick(100);
  w.write("default", "main", { pl1_w: 12 });
  c.tick(100);
  w.write("default", "main", { pl2_w: 20 });
  assert.equal(s.calls.length, 0);
  assert.equal(w.busy(), true);
  c.tick(249);
  assert.equal(s.calls.length, 0);
  c.tick(1);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].values, { pl1_w: 12, pl2_w: 20 });
  s.calls[0].resolve(answer());
  await flushMicro();
  assert.equal(w.busy(), false);
});

test("makeWriter: a long drag still sends at the latest 2 x delay after its first write", () => {
  const c = fakeClock();
  const s = fakeSend();
  const w = makeWriter(s.send, { timers: c.timers, now: c.now });
  for (let i = 0; i < 10; i++) { w.write("default", "main", { pl1_w: 10 + i }); c.tick(60); }
  assert.equal(s.calls.length, 1, "sent once during a 600 ms drag");
  assert.ok(s.calls[0].values.pl1_w < 19);
});

test("makeWriter: at most one in flight; newer changes wait and go merged, in order", async () => {
  const c = fakeClock();
  const s = fakeSend();
  const states = [];
  const answers = [];
  const w = makeWriter(s.send, { timers: c.timers, now: c.now, onState: (st) => states.push(st), onAnswer: (r, stale) => answers.push(stale) });
  w.write("default", "main", { pl1_w: 10 });
  c.tick(250);
  assert.equal(s.calls.length, 1);
  w.write("default", "main", { pl1_w: 11 });
  w.write("default", "main", { gpu_max_mhz: 1500 });
  c.tick(1000);
  assert.equal(s.calls.length, 1, "waits for the first answer");
  s.calls[0].resolve(answer(stateWith({ values: { ...stateWith().values, pl1_w: 10 } })));
  await flushMicro();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].values, { pl1_w: 11, gpu_max_mhz: 1500 });
  assert.deepEqual(states, [], "the stale first answer is not handed on");
  assert.deepEqual(answers, [true]);
  s.calls[1].resolve(answer(stateWith({ values: { ...stateWith().values, pl1_w: 11 } })));
  await flushMicro();
  assert.equal(states.length, 1);
  assert.equal(states[0].values.pl1_w, 11);
  assert.deepEqual(answers, [true, false]);
});

test("makeWriter: a change to another profile or slot is its own send, after the earlier one", async () => {
  const c = fakeClock();
  const s = fakeSend();
  const w = makeWriter(s.send, { timers: c.timers, now: c.now });
  w.write("default", "main", { pl1_w: 10 });
  w.write("1091500", "main", { pl1_w: 20 });
  w.write("1091500", "ac", { pl1_w: 30 });
  assert.equal(s.calls.length, 1, "the earlier change is complete: it goes at once");
  assert.deepEqual([s.calls[0].key, s.calls[0].slot], ["default", "main"]);
  s.calls[0].resolve(answer());
  await flushMicro();
  assert.equal(s.calls.length, 2);
  assert.deepEqual([s.calls[1].key, s.calls[1].slot, s.calls[1].values], ["1091500", "main", { pl1_w: 20 }]);
  s.calls[1].resolve(answer());
  await flushMicro();
  assert.equal(s.calls.length, 2, "the last one still waits for its delay");
  c.tick(250);
  assert.deepEqual([s.calls[2].key, s.calls[2].slot], ["1091500", "ac"]);
});

test("makeWriter: flush sends at once; while one is in flight it goes when that answers", async () => {
  const c = fakeClock();
  const s = fakeSend();
  const w = makeWriter(s.send, { timers: c.timers, now: c.now });
  w.write("default", "main", { turbo: false });
  w.flush();
  assert.equal(s.calls.length, 1);
  w.write("default", "main", { turbo: true });
  w.flush();
  assert.equal(s.calls.length, 1);
  s.calls[0].resolve(answer());
  await flushMicro();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].values, { turbo: true });
  c.tick(1000);
  assert.equal(s.calls.length, 2, "no second send of the flushed change");
});

test("makeWriter: a rejected send is an answer with ok false, and the queue goes on", async () => {
  const c = fakeClock();
  const answers = [];
  let n = 0;
  const w = makeWriter(() => (n++ ? Promise.resolve(answer()) : Promise.reject(new Error("gone"))),
    { timers: c.timers, now: c.now, onAnswer: (r) => answers.push(r) });
  w.write("default", "main", { pl1_w: 10 });
  w.flush();
  await flushMicro();
  assert.equal(answers[0].ok, false);
  assert.equal(answers[0].error, "gone");
  w.write("default", "main", { pl1_w: 11 });
  w.flush();
  await flushMicro();
  assert.equal(answers[1].ok, true);
});

test("makeWriter: drain flushes and resolves once nothing waits or is in flight", async () => {
  const c = fakeClock();
  const s = fakeSend();
  const w = makeWriter(s.send, { timers: c.timers, now: c.now });
  let done = false;
  await w.drain();                                   // idle: at once
  w.write("default", "main", { pl1_w: 10 });
  const d = w.drain().then(() => { done = true; });
  assert.equal(s.calls.length, 1, "sent at once, not after the delay");
  w.write("default", "main", { pl1_w: 11 });         // made while the first is in flight
  s.calls[0].resolve(answer());
  await flushMicro();
  assert.equal(done, false);
  assert.equal(s.calls.length, 2);
  s.calls[1].resolve(answer());
  await d;
  assert.equal(done, true);
  assert.equal(w.busy(), false);
});

test("makeWriter: version goes up with every write", () => {
  const c = fakeClock();
  const w = makeWriter(fakeSend().send, { timers: c.timers, now: c.now });
  const v = w.version();
  w.write("default", "main", { pl1_w: 10 });
  assert.equal(w.version(), v + 1);
});

// ---- the rest ------------------------------------------------------------------------------------------------------

test("editSlot: the active slot, AC only when split", () => {
  const ac = stateWith({ active: { key: "default", name: "Default", slot: "ac", app: null, ac: true } });
  assert.equal(editSlot(ac, { split_ac: true }), "ac");
  assert.equal(editSlot(ac, { split_ac: false }), "main");
  assert.equal(editSlot(stateWith(), { split_ac: true }), "main");
  assert.equal(editSlot(ac, null), "main");
});

test("shown: the stored value, else the applied (firmware) one", () => {
  const s = shown({ pl1_w: 15, pl2_w: null, gpu_min_mhz: null, gpu_max_mhz: 1800, epp: null, turbo: false },
    stateWith().applied_values);
  assert.deepEqual(s, { ...EMPTY, pl1_w: 15, pl2_w: 52, gpu_min_mhz: 100, gpu_max_mhz: 1800, epp: "balance_performance", turbo: false });
  assert.deepEqual(shown(null, null).pl1_w, null);
});

test("fwValues: the lowest boot value over the zones, the GPU's range", () => {
  assert.deepEqual(fwValues(stateWith()), { ...EMPTY, pl1_w: 25, pl2_w: 52, gpu_min_mhz: 100, gpu_max_mhz: 2300 });
  const none = stateWith();
  none.now.zones = none.now.zones.map((z) => ({ ...z, boot_pl1_w: null, boot_pl2_w: null }));
  assert.equal(fwValues(none).pl1_w, 15, "no snapshot yet: what reads now");
});

test("pl2Floor, clampW, pl1Change", () => {
  const r = stateWith().range;
  assert.equal(pl2Floor(15, r), 15);
  assert.equal(pl2Floor(3, r), 5);
  assert.equal(pl2Floor(null, r), 5);
  assert.equal(pl2Floor(20), 20);
  assert.equal(clampW(3, r), 5);
  assert.equal(clampW(60, r), 35);
  assert.equal(clampW(15.4, r), 15);
  assert.equal(clampW(NaN, r), 5);
  assert.equal(clampW(20, { pl1_min: 5, pl1_max: 4 }), 5, "an empty range gives its floor");
  assert.deepEqual(pl1Change(30, 25), { pl1_w: 30, pl2_w: 30 }, "boost moves along in the same change");
  assert.deepEqual(pl1Change(20, 25), { pl1_w: 20 });
  assert.deepEqual(pl1Change(20, null), { pl1_w: 20 });
});

test("gpuNotches: 'efficient' on the notch of rpe", () => {
  const n = gpuNotches(stateWith().range);
  assert.equal(n.notchCount, 45);
  assert.deepEqual(n.notchLabels, [{ notchIndex: 16, label: "efficient", value: 900 }]);
  assert.equal(gpuNotches({ ...stateWith().range, gpu_efficient: null }).notchLabels, undefined);
  assert.equal(gpuNotches({ ...stateWith().range, gpu_min: null }).notchCount, undefined);
});

test("effectiveLine and reasonText", () => {
  assert.equal(effectiveLine(stateWith()), "15 W / 25 W · GPU 1450 MHz, power-limited");
  const s = stateWith();
  s.now.gpu = { min: 100, max: 2300, act: 2300, reasons: [] };
  assert.equal(effectiveLine(s), "15 W / 25 W · GPU 2300 MHz");
  s.now.gpu = null;
  s.now.pl1_w = 17.125;
  assert.equal(effectiveLine(s), "17.1 W / 25 W");
  s.now.pl1_w = null; s.now.pl2_w = null;
  assert.equal(effectiveLine(s), "Power limits unreadable");
  assert.equal(reasonText(["thermal", "pl2"]), "power-limited, thermal-limited");
  assert.equal(reasonText(["odd"]), "limited by odd");
  assert.equal(reasonText([]), null);
  assert.equal(watts(null), "?");
});

test("profileLine", () => {
  assert.equal(profileLine(stateWith()), "Default · on battery");
  assert.equal(profileLine(stateWith({ active: { key: "1091500", name: "Cyberpunk 2077", slot: "main", app: "1091500", ac: true } })), "Cyberpunk 2077 · on AC");
  assert.equal(profileLine(stateWith({ active: { key: "1091500", name: "", slot: "ac", app: "1091500", ac: true } })), "App 1091500 · on AC (AC values)");
  assert.equal(profileLine(stateWith({ active: { key: "default", name: "Default", slot: "main", app: null, ac: null } })), "Default");
});

test("idText and failedLines", () => {
  assert.equal(idText("intel-rapl:0/pl1"), "MSR PL1");
  assert.equal(idText("intel-rapl-mmio:0/pl2"), "MMIO PL2");
  assert.equal(idText("intel-rapl:1/pl1"), "MSR 1 PL1");
  assert.equal(idText("gpu/max"), "GPU max clock");
  assert.equal(idText("odd"), "odd");
  assert.equal(idText("epp/policy3"), "Energy preference (EPP, policy3)");
  assert.equal(idText("intel-rapl-mmio:0/pl4"), "MMIO PL4");
  assert.deepEqual(failedLines({ ok: false, error: "x", written: [], failed: [
    { id: "intel-rapl:0/pl1", error: "locked by firmware", locked: true },
    { id: "gpu/min", error: "outside rpn..rp0", locked: false },
  ] }), [
    "MSR PL1 is locked by firmware: the limit cannot go above its value (the CPU uses the lower of the two).",
    "GPU min clock: outside rpn..rp0",
  ]);
  assert.deepEqual(failedLines(null), []);
  // the zones keep a locked limit all boot, after the last apply has stopped listing it (it skips locked ids)
  const zones = stateWith().now.zones.map((z) => (z.iface === "msr" ? { ...z, pl1_w: 25, locked: ["pl1"] } : z));
  const locked = "MSR PL1 is locked by firmware at 25 W: the limit cannot go above 25 W (the CPU uses the lower of the two).";
  assert.deepEqual(failedLines({ ok: true, error: null, written: [], failed: [] }, zones), [locked]);
  assert.deepEqual(failedLines({ ok: false, error: "x", written: [], failed: [
    { id: "intel-rapl:0/pl1", error: "locked by firmware", locked: true },
  ] }, zones), [locked]);
});

test("overriddenText and suspects", () => {
  const o = { what: "intel-rapl:0/pl1", ours: "15 W", now: "35 W", since: 1, suspects: ["hhd", "steam", "gone"] };
  const cs = [{ id: "hhd", name: "Handheld Daemon", kind: "blocks", ignorable: true, ignored: true, why: "", fix: "turn off its TDP" }];
  assert.equal(overriddenText(o, cs), "Something else changed the power limits (now 35 W, OXP3 Deck set 15 W). Likely: Handheld Daemon, Steam, gone.");
  const s = suspects(o, cs);
  assert.equal(s[0].fix, "turn off its TDP");
  assert.match(s[1].fix, /turn off "TDP limit" and "Manual GPU clock"/);
  assert.equal(overriddenText({ ...o, suspects: [] }, null), "Something else changed the power limits (now 35 W, OXP3 Deck set 15 W).");
});

test("eppOptions: Firmware first, then the CPU's choices in the fixed order", () => {
  assert.deepEqual(eppOptions(["power", "performance"]).map((o) => o.data), [null, "performance", "power"]);
  assert.equal(eppOptions(null).length, 5);
});

test("profileOrder: Default, the running game, then by name", () => {
  const ps = { default: { name: null }, 2: { name: "Zeta" }, 1: { name: "Alpha" }, 3: { name: null } };
  assert.deepEqual(profileOrder(ps, "2").map((o) => o.key), ["default", "2", "1", "3"]);
  assert.equal(profileOrder(ps, "2")[1].label, "Zeta (running)");
  assert.equal(profileOrder(ps, null)[3].label, "Zeta");
  assert.equal(profileOrder(ps, null)[1].label, "Alpha");
});

test("blockers: blocking and not ignored", () => {
  const c = (id, kind, ignored) => ({ id, name: id, kind, ignorable: true, ignored, why: "", fix: "" });
  assert.deepEqual(blockers([c("a", "blocks", false), c("b", "blocks", true), c("c", "cpu", false), c("d", "suspect", false)]).map((x) => x.id), ["a"]);
  assert.deepEqual(blockers(undefined), []);
});

// ---- 0.4 ---------------------------------------------------------------------------------------------------------

test("FIELDS and EMPTY have the 19 names of power.py, in its order", () => {
  assert.deepEqual([...FIELDS], ["pl1_w", "pl2_w", "gpu_min_mhz", "gpu_max_mhz", "epp", "turbo",
    "cpu_max_pct", "cpu_min_pct", "soc_balance", "soc_offset", "gpu_power_profile",
    "cpu_cap_p_mhz", "cpu_cap_e_mhz", "cpu_cap_lpe_mhz", "epp_p", "epp_e", "epp_lpe", "fan_mode", "scx_mode"]);
  assert.deepEqual(Object.keys(EMPTY).sort(), [...FIELDS].sort());
  assert.ok(Object.values(EMPTY).every((v) => v === null));
  // reset leaves the fan and the scheduler mode alone
  assert.deepEqual(Object.keys(RESET).sort(), FIELDS.filter((f) => f !== "fan_mode" && f !== "scx_mode").sort());
});

test("the polling rate's index slider over POLL_STEPS", () => {
  assert.deepEqual([...POLL_STEPS], [0, 2, 3, 5, 10, 15, 20, 30, 45, 60]);
  POLL_STEPS.forEach((v, i) => { assert.equal(pollIndex(v), i); assert.equal(pollValue(i), v); });
  assert.equal(pollIndex(undefined), 1, "unknown: the default (2 s)");
  assert.equal(pollIndex(11), 4);
  assert.equal(pollValue(-3), 0);
  assert.equal(pollValue(99), 60);
  assert.equal(pollText(0), "Off");
  assert.equal(pollText(15), "15 s");
});

test("speed cap or per-core caps, switched in one change", () => {
  assert.deepEqual([...CORE_TYPES], ["p", "e", "lpe"]);
  assert.equal(usesCaps(EMPTY), false);
  assert.equal(usesCaps({ ...EMPTY, cpu_cap_e_mhz: 2400 }), true);
  assert.deepEqual(toCaps({ p: 3000 }), { cpu_max_pct: null, cpu_cap_p_mhz: 3000, cpu_cap_e_mhz: null, cpu_cap_lpe_mhz: null });
  assert.deepEqual(toPct(70), { cpu_max_pct: 70, cpu_cap_p_mhz: null, cpu_cap_e_mhz: null, cpu_cap_lpe_mhz: null });
});

test("CPU minimum speed range: the firmware floor to 50, never above the cap", () => {
  assert.deepEqual(minPctRange({ cpu_min_pct_fw: 9, cpu_min_pct_max: 50 }, 100), { lo: 9, hi: 50 });
  assert.deepEqual(minPctRange({ cpu_min_pct_fw: 9, cpu_min_pct_max: 50 }, 40), { lo: 9, hi: 40 });
  assert.deepEqual(minPctRange({ cpu_min_pct_fw: null }, null), { lo: 1, hi: 50 });
  assert.deepEqual(minPctRange({ cpu_min_pct_fw: 30, cpu_min_pct_max: 50 }, 20), { lo: 30, hi: 30 });
});

test("transient failures (the GPU asleep) are not red rows; 'other' suspects read as Another program", () => {
  const last = { ok: true, error: null, written: [], failed: [{ id: "gpu/profile", error: "EAGAIN", locked: false, transient: true }] };
  assert.deepEqual(failedLines(last, []), []);
  const o = { what: "cpu/max_pct", ours: "70", now: "100", since: 1, suspects: ["other"] };
  assert.deepEqual(suspects(o, []), [{ name: "Another program", fix: "" }]);
  assert.equal(idText("cpu/max_pct"), "CPU speed cap (max_perf_pct)");
  assert.equal(idText("cpu/cap/policy4"), "Core speed cap (policy4)");
});
