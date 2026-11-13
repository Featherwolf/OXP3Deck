// Tests for src/quickgroups.ts (DESIGN.md "Quick Access groups"). Run from the repository root:
// node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./tsresolve.mjs";

const Q = await import("../../src/quickgroups.ts");
const { EMPTY } = await import("../../src/power.ts");

const LONG = "The Elder Scrolls V: Skyrim Special Edition – Anniversary Upgrade and Creation Club Bundle";

const state = (over = {}) => ({
  enabled: true,
  active: { key: "default", name: "", slot: "main", app: null, ac: false },
  values: { ...EMPTY, pl1_w: 15, pl2_w: 25, gpu_min_mhz: 300, gpu_max_mhz: 2300, cpu_max_pct: 60, turbo: false, scx_mode: "gaming", fan_mode: "auto" },
  applied_values: { ...EMPTY },
  now: { pl1_w: 15, pl2_w: 25, zones: [], gpu: { min: 300, max: 2300, act: 1200, reasons: [] }, epp: null, turbo: false, governor: "powersave",
    cpu_max_pct: 60, cpu_min_pct: 9, soc: null },
  range: { pl1_min: 5, pl1_max: 30, pl2_max: 40, pl1_max_battery: 30, pl1_max_ac: 45, extended_max: null, gpu_min: 300, gpu_max: 2300,
    gpu_efficient: 1100, spec: "oxp3" },
  overridden: null, blocked: null, cpu_blocked: null, cpu_blocked_by: [], last: null,
  ...over,
});
const info = (over = {}) => ({
  hw: { rapl: true, mmio: true, gpu: null, cpu: { pstate: "active", epp_choices: [], turbo: true, perf_pct: true, types: [] }, soc: false,
    ac_supply: null, problems: [] },
  options: { per_game: true, split_ac: false, extended: false, ignore: [], poll_s: 2 },
  profiles: { default: { name: null, main: { ...EMPTY }, ac: null } },
  conflicts: [], fixed: [], boot: null, sdtdp_found: false, state: null,
  ...over,
});
const extras = (over = {}) => ({
  board_ok: true, kernel: "7.4",
  charge: { available: true, why: null, limit: 80, behaviour: "inhibit-charge-awake", behaviours: ["auto", "inhibit-charge-awake"],
    overridden: { limit: null, behaviour: null } },
  fan: { available: true, why: null, rpm: 3000, mode_now: "auto", ours: "auto", reverted: null, overridden: null, sleep_watch: true },
  scx: { shown: true, available: true, why: null, scheduler: "scx_lavd", mode: "gaming", ours: "gaming", overridden: null },
  lpmd: { shown: false, paused: false, state: null, error: null },
  options: { charge_limit: 80, charge_behaviour: "inhibit-charge-awake", lpmd_game_off: false },
  ...over,
});

test("defaults: This game and Power open, the rest closed; ids in panel order", () => {
  assert.deepEqual(Q.GROUPS.map((g) => g.id), ["live", "game", "power", "cpu", "battery", "xess", "fixes"]);
  const open = Q.GROUPS.filter((g) => Q.isOpen({}, g.id)).map((g) => g.id);
  assert.deepEqual(open, ["game", "power"]);
  assert.equal(Q.GROUPS_KEY, "quickGroups");
});

test("parseGroups: junk, unknown ids and non-booleans are ignored; a partial object keeps the rest at defaults", () => {
  for (const junk of [null, undefined, "", "{", "null", "[]", "42", '"x"', "[true]"]) assert.deepEqual(Q.parseGroups(junk), {}, String(junk));
  assert.deepEqual(Q.parseGroups('{"live":true,"nope":true,"cpu":"yes","power":false}'), { live: true, power: false });
  const s = Q.parseGroups('{"power":false}');
  assert.equal(Q.isOpen(s, "power"), false);
  assert.equal(Q.isOpen(s, "game"), true);
  assert.equal(Q.isOpen(s, "fixes"), false);
});

test("toggled stores only the toggled group and round-trips through JSON", () => {
  let s = Q.toggled({}, "cpu");
  assert.deepEqual(s, { cpu: true });
  s = Q.toggled(s, "power");
  assert.deepEqual(s, { cpu: true, power: false });
  s = Q.toggled(s, "cpu");
  assert.deepEqual(Q.parseGroups(JSON.stringify(s)), { cpu: false, power: false });
});

test("an alert wins over the summary, in red; the first alert there is the one shown", () => {
  assert.deepEqual(Q.headerLine("15 W · boost 25 W", null), { text: "15 W · boost 25 W", red: false });
  const a = Q.alertOf([null, false, { label: "Power control paused", line: "Power Profiles is also changing power limits." }, { label: "second", line: null }]);
  assert.equal(a.label, "Power control paused");
  const h = Q.headerLine("15 W · boost 25 W", a);
  assert.equal(h.red, true);
  assert.equal(h.text, "Power control paused: Power Profiles is also changing power limits.");
  assert.ok(Q.headerLine("x", { label: LONG, line: LONG }).text.length <= 80);
  assert.equal(Q.alertOf([null, undefined, false]), null);
});

test("powerAlert: paused, overridden, the performance governor, unavailable, a refused enable, a read error", () => {
  assert.equal(Q.powerAlert(info(), state(), null), null);
  const blocks = { id: "ppd", name: "power-profiles-daemon", kind: "blocks", ignorable: true, ignored: false, why: "", fix: "", fix_units: [], fixed: null };
  assert.equal(Q.powerAlert(info({ conflicts: [blocks] }), state({ blocked: "ppd writes" }), null).label, "Power control paused");
  assert.equal(Q.powerAlert(info(), state({ overridden: { what: "pl1", ours: "15", now: "20", since: 1, suspects: [] } }), null).label,
    "Something changed your power limits");
  assert.equal(Q.powerAlert(info(), state({ now: { ...state().now, governor: "performance" } }), null).label, "CPU speed policy is Performance");
  assert.equal(Q.powerAlert(info({ hw: { ...info().hw, problems: ["No RAPL. Nothing to set."] } }), state({ enabled: false }), null).label,
    "Power control unavailable");
  assert.match(Q.powerAlert(info(), state({ enabled: false }), null, [blocks]).label, /^Turn off .+ first$/);
  assert.equal(Q.powerAlert(null, null, "timed out").label, "Power: did not work");
  // power control off: paused and overridden are not shown
  assert.equal(Q.powerAlert(info(), state({ enabled: false, blocked: "x" }), null), null);
});

test("cpuAlert and batteryAlert: something else took over; nothing otherwise", () => {
  assert.equal(Q.cpuAlert(info(), state(), extras()), null);
  assert.equal(Q.cpuAlert(info(), state(), extras({ scx: { ...extras().scx, overridden: "CachyOS switched it" } })).label,
    "Something else changed the scheduler mode");
  const lpmd = { id: "intel_lpmd", name: "intel_lpmd", kind: "cpu", ignorable: true, ignored: false, why: "", fix: "", fix_units: [], fixed: null };
  const locked = Q.cpuAlert(info({ conflicts: [lpmd] }), state({ cpu_blocked: "lpmd controls EPP", cpu_blocked_by: ["intel_lpmd"] }), extras());
  assert.equal(locked.label, "CPU controls locked");
  assert.match(locked.line, /^Locked by /);
  assert.equal(Q.batteryAlert(extras()), null);
  assert.equal(Q.batteryAlert(extras({ fan: { ...extras().fan, overridden: "hhd" } })).label, "Something else changed the fan");
  assert.equal(Q.batteryAlert(extras({ charge: { ...extras().charge, error: "write failed" } })).label, "Battery: did not work");
});

test("summaries: the examples of DESIGN.md", () => {
  const s = state();
  const v = Q.editedValues(s, s.values);
  assert.equal(Q.powerSummary(s, v), "15 W · boost 25 W · GPU 300–2300 MHz · Default");
  assert.equal(Q.powerSummary(state({ enabled: false }), v), "Off · device defaults");
  assert.equal(Q.powerSummary(null, null), "Reading…");
  assert.match(Q.powerSummary(state({ blocked: "Power Profiles changes limits" }), v), /^Paused · Power Profiles changes limits/);
  assert.equal(Q.cpuSummary(s, info(), v, "gaming", extras()), "Cap 60 % · Boost off · Scheduler Gaming");
  assert.equal(Q.cpuSummary(state({ enabled: false }), info(), v, "gaming", extras()), "Power control off · Scheduler Gaming");
  assert.equal(Q.batterySummary(extras(), "auto"), "Fan Auto · Charge to 80 % · Battery idle on charger");
  assert.equal(Q.xessSummary({ installed: true, version: "20261104", status: "ok", line: null, live: true, relogin_needed: false }, true),
    "On (20261104) · Update available");
  assert.equal(Q.xessSummary({ installed: true, version: "1", status: "ok", line: null, live: true, relogin_needed: true }, false), "Log out needed");
  assert.match(Q.xessSummary({ installed: true, version: "1", status: "failed", line: null, live: false, relogin_needed: false }, false), /^✗ /);
  assert.equal(Q.fixesSummary({ installed: true, usable: true, update: false, applied: 7, recommended: 2, attention: 0 }), "7 applied · 2 recommended");
  assert.equal(Q.fixesSummary({ installed: false, usable: false, update: false, applied: null, recommended: 0, attention: 0 }), "Fixes tool not installed");
  assert.equal(Q.gameSummary("Cyberpunk 2077", "auto", true), "Cyberpunk 2077 · Automatic · Own power profile");
  assert.equal(Q.gameSummary("Hades II", "manual", false), "Hades II · Manual");
  assert.equal(Q.liveSummary(null, "boom"), "Couldn't read.");
  assert.equal(Q.liveSummary(null, null), "Reading…");
});

test("summaries: null fields read 'default', the profile name shows, a game's slot is the one edited", () => {
  const s = state({ values: { ...EMPTY }, applied_values: { ...EMPTY }, now: { ...state().now, pl1_w: null, pl2_w: null },
    range: { ...state().range, gpu_min: null, gpu_max: null } });
  assert.equal(Q.powerSummary(s, Q.editedValues(s, s.values)), "default · boost default · Default");
  const g = state({ active: { key: "1091500", name: "Cyberpunk 2077", slot: "main", app: "1091500", ac: false } });
  assert.match(Q.powerSummary(g, Q.editedValues(g, g.values)), / · Cyberpunk 2077$/);
  const e = Q.editedSlot(g, info());
  assert.equal(e.slot, "main");
  assert.equal(e.stored.pl1_w, 15);
  assert.equal(e.label, "the profile of Cyberpunk 2077");
});

test("every summary fits in 80 characters, for long game names and every value at null", () => {
  const nulls = state({ values: { ...EMPTY }, applied_values: { ...EMPTY }, now: { ...state().now, pl1_w: null, pl2_w: null, cpu_max_pct: null, turbo: null } });
  const longGame = state({ active: { key: "1", name: LONG, slot: "main", app: "1", ac: true }, yielded: ["epp", "turbo", "soc"] });
  const lines = [
    Q.powerSummary(nulls, Q.editedValues(nulls, nulls.values)),
    Q.powerSummary(longGame, Q.editedValues(longGame, longGame.values), { yieldedTo: LONG, gpuHeld: true }),
    Q.powerSummary(state({ blocked: LONG + LONG }), null),
    Q.cpuSummary(nulls, info(), Q.editedValues(nulls, nulls.values), null, extras()),
    Q.cpuSummary(null, null, null, null, null),
    Q.batterySummary(extras({ fan: { ...extras().fan, reverted: LONG } }), "quiet"),
    Q.batterySummary(null, null),
    Q.xessSummary(null, true),
    Q.xessSummary({ installed: true, version: LONG, status: "ok", line: null, live: true, relogin_needed: false }, true),
    Q.fixesSummary({ installed: true, usable: true, update: true, applied: 12, recommended: 9, attention: 3 }),
    Q.fixesSummary({ installed: true, usable: true, update: true, applied: null, recommended: 0, attention: 0 }),
    Q.gameSummary(LONG, "auto", true),
    Q.gameSummary(LONG, null, false),
    Q.gameSummary("", null, false),
    Q.liveSummary(null, null),
  ];
  for (const l of lines) {
    assert.ok(typeof l === "string" && l.length > 0 && l.length <= 80, `${l.length}: ${l}`);
  }
  assert.match(Q.gameSummary(LONG, "auto", true), / · Automatic · Own power profile$/, "the game's state survives a long name");
});

test("pinned errors: kept when the group closes, dropped when the row goes away in an open group, cleared on open", () => {
  const p = Q.makePins();
  assert.equal(p.set("power", 1, "Refused"), true);
  assert.equal(p.set("power", 1, "Refused"), false, "the same error again changes nothing");
  p.set("power", 2, "Other");
  assert.deepEqual(p.of("power"), ["Refused", "Other"]);
  assert.equal(p.drop("power", 1, false), false, "unmounted because the group closed: kept");
  assert.deepEqual(p.of("power"), ["Refused", "Other"]);
  assert.equal(p.drop("power", 1, true), true, "unmounted in an open group: nothing could clear it later");
  assert.deepEqual(p.of("power"), ["Other"]);
  assert.equal(p.set("power", 2, null), true);
  assert.deepEqual(p.of("power"), []);
  assert.equal(p.set("power", 3, ""), false, "no error: nothing pinned");
  p.set("game", 4, "x");
  assert.equal(p.clear("game"), true);
  assert.equal(p.clear("game"), false);
  assert.deepEqual(p.of("game"), []);
});

test("refusedLive: a fixed conflict and power control on end the refused enable's alert", () => {
  const c = { id: "ppd", kind: "power", name: "Power Profiles", ignored: false };
  const i = info({ conflicts: [c], fixed: [] });
  assert.deepEqual(Q.refusedLive([c], i).map((x) => x.id), ["ppd"]);
  assert.deepEqual(Q.refusedLive([c], i, true), [], "power control on: nothing refused any more");
  const fixed = info({ conflicts: [], fixed: [{ id: "ppd" }] });
  assert.deepEqual(Q.refusedLive([c], fixed), [], "fixed since");
  assert.equal(Q.powerAlert(fixed, state({ enabled: false }), null, Q.refusedLive([c], fixed)), null);
  assert.match(Q.powerAlert(i, state({ enabled: false }), null, Q.refusedLive([c], i)).label, /^Turn off/);
  assert.deepEqual(Q.refusedLive([c], null).map((x) => x.id), ["ppd"], "no power-info yet: the answer's copy");
});
