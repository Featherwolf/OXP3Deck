// Tests for the performance batch's frontend (DESIGN.md "Performance batch (ROADMAP N-1, N-2 + N-5 read, T1-2, N-4,
// T1-11 + N-7)"): presets, low battery, device check, power tips and the VRR row (power.ts, display.ts,
// quickgroups.ts, effects.ts), plus source checks of the rows that need Steam's React.
// Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const P = await import("../../src/power.ts");
const Q = await import("../../src/quickgroups.ts");
const D = await import("../../src/display.ts");
const { EFFECTS, effectText } = await import("../../src/effects.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const FIX = JSON.parse(readFileSync(new URL("../fixtures/power/presets.json", import.meta.url), "utf8"));
const FULL = FIX.caps;

// ---- C. presets ------------------------------------------------------------------------------------------------

test("presetValues and presetCeiling match the shared fixture for every slot", () => {
  assert.deepEqual([...P.PRESET_FIELDS], FIX.fields);
  assert.ok(FIX.cases.length >= 5);
  for (const c of FIX.cases) {
    const range = FIX.range[c.range];
    assert.equal(P.presetCeiling(range, c.slot, c.opts), c.ceiling, `${c.name}: ceiling`);
    for (const id of P.PRESET_IDS) {
      const got = P.presetValues(id, range, c.slot, c.opts, FULL);
      assert.deepEqual(got, c.presets[id], `${c.name}: ${id}`);
    }
  }
});

test("the Battery preset of the low slot equals BATTERY_PRESET (power.py has the same)", () => {
  const low = FIX.cases.find((c) => c.slot === "low");
  const want = Object.fromEntries(Object.entries(low.presets.battery).filter(([, v]) => v !== null));
  assert.deepEqual(P.BATTERY_PRESET, want);
  const ls = P.lowStored(null);
  for (const f of P.FIELDS) assert.equal(ls[f], P.BATTERY_PRESET[f] ?? null, f);
  const own = { ...P.EMPTY, pl1_w: 8 };
  assert.equal(P.lowStored(own), own);
});

test("presets clamp at the slot ceiling and the range's floor", () => {
  const tiny = { pl1_min: 12, pl2_max: 20, pl1_max_battery: 14, pl1_max_ac: 16, extended_max: null };
  const o = { split_ac: true, extended: false };
  const b = P.presetValues("battery", tiny, "main", o, FULL);
  assert.equal(b.pl1_w, 12);            // 10 W below the floor
  assert.equal(b.pl2_w, 15);
  const perf = P.presetValues("performance", tiny, "main", o, FULL);
  assert.equal(perf.pl1_w, 14);         // 28 W above the battery ceiling
  assert.equal(perf.pl2_w, null);
  const bal = P.presetValues("balanced", tiny, "ac", o, FULL);
  assert.equal(bal.pl1_w, 16);
  assert.equal(bal.pl2_w, 20);          // 25 W above pl2_max
  const max = P.presetValues("max", tiny, "ac", { split_ac: true, extended: true }, FULL);
  assert.equal(max.pl1_w, 16);          // no extended_max: the AC ceiling
  assert.equal(max.pl2_w, 20);
});

test("fields the device or a conflict does not allow are left out, not nulled", () => {
  const r = FIX.range.battery;
  const o = { split_ac: false, extended: false };
  const none = P.presetValues("battery", r, "main", o, { epp_choices: [], turbo: false, gpu_profile: false, cpu_blocked: false });
  assert.deepEqual(Object.keys(none).sort(), ["pl1_w", "pl2_w"]);
  const blocked = P.presetValues("max", r, "main", o, { ...FULL, cpu_blocked: true });
  assert.equal("epp" in blocked, false);
  assert.equal("turbo" in blocked, false);
  assert.equal(blocked.gpu_power_profile, "base");
  const noPower = P.presetValues("battery", r, "main", o, { ...FULL, epp_choices: ["performance", "balance_performance"] });
  assert.equal("epp" in noPower, false);
  assert.equal(noPower.turbo, false);
  // never touched by any preset
  for (const id of P.PRESET_IDS) {
    const v = P.presetValues(id, r, "main", o, FULL);
    for (const f of ["cpu_max_pct", "cpu_min_pct", "soc_balance", "gpu_min_mhz", "fan_mode", "scx_mode", "cpu_cap_p_mhz", "gpu_max_mhz"]) {
      assert.equal(f in v, false, `${id}: ${f}`);
    }
  }
});

test("presetCaps reads the device and the conflicts", () => {
  const info = { hw: { cpu: { epp_choices: ["performance"], turbo: true }, gpu: { power_profile: true } } };
  assert.deepEqual(P.presetCaps(info, { cpu_blocked: null }), { epp_choices: ["performance"], turbo: true, gpu_profile: true, cpu_blocked: false });
  assert.equal(P.presetCaps(info, { cpu_blocked: "tuned controls it" }).cpu_blocked, true);
  assert.equal(P.presetCaps(info, { cpu_blocked: null, blocked_fields: { epp: ["ppd"] } }).cpu_blocked, true);
  assert.deepEqual(P.presetCaps(null, null), { epp_choices: [], turbo: false, gpu_profile: false, cpu_blocked: false });
});

test("presetOf: each preset, custom after one field changes, default for all null", () => {
  const r = FIX.range.battery;
  const o = { split_ac: false, extended: false };
  for (const id of P.PRESET_IDS) {
    const v = { ...P.EMPTY, cpu_max_pct: 70, fan_mode: "quiet", ...P.presetValues(id, r, "main", o, FULL) };
    assert.equal(P.presetOf(v, r, "main", o, FULL), id, id);
    assert.equal(P.presetOf({ ...v, pl1_w: v.pl1_w - 1 }, r, "main", o, FULL), "custom", `${id} - 1 W`);
  }
  const bal = { ...P.EMPTY, ...P.presetValues("balanced", r, "main", o, FULL) };
  assert.equal(P.presetOf({ ...bal, epp: "performance" }, r, "main", o, FULL), "custom");
  assert.equal(P.presetOf({ ...bal, turbo: false }, r, "main", o, FULL), "custom");
  assert.equal(P.presetOf(P.EMPTY, r, "main", o, FULL), "default");
  assert.equal(P.presetOf({ ...P.EMPTY, cpu_max_pct: 60 }, r, "main", o, FULL), "default");   // not a preset field
  assert.equal(P.presetOf(null, r, "main", o, FULL), "default");
  // a stored value above the ceiling counts after clamping (a split slot shows the battery ceiling)
  assert.equal(P.presetOf({ ...P.EMPTY, pl1_w: 40, pl2_w: 52, epp: "performance", turbo: true, gpu_power_profile: "base" }, r, "main",
    { split_ac: true, extended: false }, FULL), "max");
  // a field the device lacks is not compared
  const noCaps = { epp_choices: [], turbo: false, gpu_profile: false, cpu_blocked: false };
  assert.equal(P.presetOf({ ...P.EMPTY, pl1_w: 10, pl2_w: 15, epp: "performance" }, r, "main", o, noCaps), "battery");
});

test("presetFieldsOf keeps only the preset fields (Undo)", () => {
  const v = { ...P.EMPTY, pl1_w: 12, turbo: true, cpu_max_pct: 70 };
  assert.deepEqual(P.presetFieldsOf(v), { pl1_w: 12, pl2_w: null, epp: null, epp_p: null, epp_e: null, epp_lpe: null, turbo: true, gpu_power_profile: null });
  assert.equal(P.presetFieldsOf({ ...v, epp_e: "power" }).epp_e, "power");     // Undo brings the per-type EPP back
});

test("a preset clears the per-core-type EPP (the backend prefers it) and keeps the GPU speed cap", () => {
  const r = FIX.range.battery;
  const o = { split_ac: false, extended: false };
  const slot = { ...P.EMPTY, gpu_max_mhz: 1500, epp_p: "performance", epp_e: "power" };
  const v = { ...slot, ...P.presetValues("battery", r, "main", o, FULL) };
  assert.deepEqual([v.epp, v.epp_p, v.epp_e, v.epp_lpe], ["balance_power", null, null, null]);
  assert.equal(v.gpu_max_mhz, 1500);
  assert.equal(P.presetOf(v, r, "main", o, FULL), "battery");
  assert.equal(P.presetOf({ ...v, epp_e: "power" }, r, "main", o, FULL), "custom");
  assert.equal(P.presetOf({ ...P.EMPTY, epp_p: "power" }, r, "main", o, FULL), "custom");
  // with the CPU group blocked no EPP field is written, per-type included
  const blocked = P.presetValues("battery", r, "main", o, { ...FULL, cpu_blocked: true });
  assert.equal("epp_p" in blocked, false);
});

test("presetLine ≤ 80, provisional until measured; presetDetails says so", () => {
  const v = { pl1_w: 17, pl2_w: 25 };
  assert.equal(P.presetLine("balanced", v, false), "Balanced: 17 W, boost 25 W · not yet measured on this device");
  assert.equal(P.presetLine("balanced", v, true), "Balanced: 17 W, boost 25 W");
  assert.equal(P.presetLine("custom", v, false), "Custom: set by hand");
  assert.equal(P.presetLine("default", {}, false), "Device defaults");
  for (const id of P.PRESET_IDS) {
    const line = P.presetLine(id, { pl1_w: 152, pl2_w: id === "performance" ? null : 152 }, false);
    assert.ok(line.length <= 80, line);
  }
  assert.match(P.presetDetails("balanced", v, []).join(" "), /not yet measured on this device/);
  const m = { at: 1, mode: "game", seconds: 60, pl1_w: 17, avg_package_w: 14.2, avg_gpu_busy_pct: 78, reasons: {} };
  const d = P.presetDetails("balanced", v, [m]).join(" ");
  assert.doesNotMatch(d, /not yet measured/);
  assert.match(d, /Measured: 60 s at 17 W, 14\.2 W average, GPU 78 %/);
});

// ---- D. low battery --------------------------------------------------------------------------------------------

test("editSlot is low while the low-battery values run; editedSlot edits Default's low slot", () => {
  const st = { active: { key: "1091500", name: "Cyberpunk 2077", slot: "low", app: "1091500", ac: false }, values: P.EMPTY };
  assert.equal(P.editSlot(st, { split_ac: true }), "low");
  assert.equal(P.editSlot({ active: { slot: "ac" } }, { split_ac: true }), "ac");
  assert.equal(P.editSlot({ active: { slot: "ac" } }, { split_ac: false }), "main");
  const info = { options: { split_ac: false }, profiles: { default: { name: null, main: P.EMPTY, ac: null, low: null } } };
  const e = Q.editedSlot(st, info);
  assert.equal(e.key, "default");
  assert.equal(e.slot, "low");
  assert.equal(e.stored.pl1_w, 10);
  assert.match(e.label, /low-battery values \(Default\)/);
  const own = { ...P.EMPTY, pl1_w: 7 };
  assert.equal(Q.editedSlot(st, { ...info, profiles: { default: { ...info.profiles.default, low: own } } }).stored, own);
  const normal = Q.editedSlot({ ...st, active: { ...st.active, slot: "main" } }, info);
  assert.equal(normal.key, "1091500");
});

test("lowLine: active, held (muted) and hidden; lowOptions defaults; the toggle's line", () => {
  assert.equal(P.lowLine(null), null);
  assert.equal(P.lowLine({ active: false, held: false, pct: 50, enter_pct: 20, leave_pct: 25, since: null }), null);
  assert.deepEqual(P.lowLine({ active: true, held: false, pct: 18, enter_pct: 20, leave_pct: 25, since: 1 }),
    { label: "Low battery", line: "18 %: saving power until 25 % or plugged in.", muted: false });
  const h = P.lowLine({ active: false, held: true, pct: 18, enter_pct: 20, leave_pct: 25, since: 1 }, "Cyberpunk 2077");
  assert.equal(h.line, "18 %: Cyberpunk 2077 keeps its own profile.");
  assert.equal(h.muted, true);
  const long = P.lowLine({ active: false, held: true, pct: 18, enter_pct: 20, leave_pct: 25, since: 1 }, "x".repeat(120));
  assert.ok(long.line.length <= 80);
  assert.deepEqual(P.lowOptions(undefined), { on: true, pct: 20, games: false });
  assert.deepEqual(P.lowOptions({ low_battery: false, low_battery_pct: 30, low_battery_games: true }), { on: false, pct: 30, games: true });
  assert.equal(P.lowToggleLine(20), "Below 20 % on battery, use battery-saving values until 25 % or plugged in.");
});

test("powerSummary puts the preset first, Low battery first while it runs, ≤ 80", () => {
  const s = {
    enabled: true, blocked: null, active: { key: "default", name: "", slot: "main", app: null, ac: false }, low: null,
    values: { ...P.EMPTY, pl1_w: 17, pl2_w: 25 },
    range: { gpu_min: 300, gpu_max: 2300 },
  };
  assert.equal(Q.powerSummary(s, s.values, { preset: "Balanced" }), "Balanced · 17 W · boost 25 W · GPU default · Default");
  const low = { ...s, active: { ...s.active, slot: "low" }, low: { active: true, held: false, pct: 18, enter_pct: 20, leave_pct: 25, since: 1 } };
  assert.match(Q.powerSummary(low, { ...P.EMPTY, pl1_w: 10, pl2_w: 15 }, { preset: "Battery" }), /^Low battery · Battery · 10 W/);
  const game = { ...s, active: { key: "1", name: "x".repeat(100), slot: "main", app: "1", ac: false } };
  assert.ok(Q.powerSummary(game, s.values, { preset: "Performance", gpuHeld: true }).length <= 80);
  assert.equal(Q.powerSummary(s, s.values), "17 W · boost 25 W · GPU default · Default");
});

// ---- B. device check -------------------------------------------------------------------------------------------

const probe = (id, outcome, over = {}) => ({ id, label: id, before: null, tried: null, read: null, restored: true, outcome, why: null, ...over });

test("selftestLine counts what works and what not; red only when a probe was not put back", () => {
  assert.equal(P.selftestLine(null), null);
  const t = { at: 100, kernel: "7.2.10", bios: "1.0", time_windows: {}, stopped: null, reapplied: null,
    probes: [...Array.from({ length: 11 }, (_, i) => probe(`p${i}`, "ok")), probe("intel-rapl:0/pl1", "locked"), probe("soc/balance", "skipped")] };
  const fmt = (x) => `T${x}`;
  assert.deepEqual(P.selftestLine(t, fmt), { line: "11 of 12 work · 1 locked by firmware · 1 skipped · T100", red: false });
  const bad = { ...t, probes: [probe("gpu/max", "not_restored"), probe("epp", "ok")] };
  const b = P.selftestLine(bad, fmt);
  assert.equal(b.red, true);
  assert.match(b.line, /^1 of 2 work · 1 not put back/);
  assert.match(P.selftestLine({ ...t, stopped: "A game started" }, fmt).line, /stopped/);
  assert.match(P.dateText(0), /^\d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/);
});

test("probeLine says each outcome in words", () => {
  assert.equal(P.probeLine(probe("intel-rapl:0/pl1", "locked", { label: "Sustained power (MSR)" })), "Sustained power (MSR): locked by firmware");
  assert.equal(P.probeLine(probe("gpu/max", "ok", { label: "GPU maximum speed", before: "2300 MHz", tried: "2250 MHz" })),
    "GPU maximum speed: works (2300 MHz → 2250 MHz)");
  assert.match(P.probeLine(probe("turbo", "skipped", { why: "CPU boost is off" })), /not tried: CPU boost is off/);
  assert.match(P.probeLine(probe("x", "ignored", { read: "25 W" })), /ignored the change \(stayed 25 W\)/);
  assert.match(P.probeLine(probe("x", "unsupported")), /not supported/);
  assert.match(P.probeLine(probe("x", "not_restored", { read: "24 W" })), /did not go back \(reads 24 W\)/);
});

test("tauText and the time-window lines (MSR first)", () => {
  assert.equal(P.tauText(28000000), "28 s");
  assert.equal(P.tauText(10000000), "10 s");
  assert.equal(P.tauText(2500000), "2.5 s");
  assert.equal(P.tauText(1000000), "1.0 s");
  assert.equal(P.tauText(2440), "2.4 ms");
  assert.equal(P.tauText(976), "976 µs");
  assert.equal(P.tauText(null), "?");
  const tw = { "intel-rapl-mmio:0": { pl1_us: 1000000, pl2_us: null }, "intel-rapl:0": { pl1_us: 28000000, pl2_us: 2440 } };
  assert.equal(P.timeWindowsLine(tw), "Sustained over 28 s, boost over 2.4 ms");
  const lines = P.timeWindowsLines(tw);
  assert.match(lines[0], /^MSR \(intel-rapl:0\): sustained 28 s, boost 2\.4 ms$/);
  assert.match(lines[1], /^MMIO \(intel-rapl-mmio:0\): sustained 1\.0 s, boost \?$/);
  assert.equal(P.timeWindowsLine({}), null);
  assert.equal(P.timeWindowsLine(undefined), null);
  assert.equal(P.timeWindowsLine({ "intel-rapl:0": { pl1_us: null, pl2_us: null } }), null);
});

test("measureLine for idle and a game, ≤ 80; measureLines list every field", () => {
  const idle = { at: 1, mode: "idle", appid: null, name: null, seconds: 60, ac: false, profile: "default", slot: "main", pl1_w: 25, pl2_w: 52,
    avg_package_w: 4.1, max_package_w: 6, avg_gpu_busy_pct: 3, avg_battery_w: 7.5, reasons: {}, cpu_throttle_ms: 0, interrupted: null };
  assert.equal(P.measureLine(idle), "Idle on battery: 4.1 W average, 6.0 W peak, GPU 3 %");
  const game = { ...idle, mode: "game", appid: "1091500", name: "Cyberpunk 2077", avg_package_w: 24.6, avg_gpu_busy_pct: 98, reasons: { pl1: 0.92, thermal: 0.1 } };
  assert.equal(P.measureLine(game), "Cyberpunk 2077 at 25 W: 24.6 W average, GPU 98 %, power-limited 92 %");
  const long = { ...game, name: "y".repeat(120), pl1_w: 152, avg_package_w: 151.4 };
  assert.ok(P.measureLine(long).length <= 80, P.measureLine(long));
  assert.equal(P.measureLine(null), null);
  const lines = P.measureLines({ ...game, interrupted: "the game ended" }, (t) => `T${t}`);
  assert.match(lines.join("\n"), /T1 · 60 s · Cyberpunk 2077/);
  assert.match(lines.join("\n"), /pl1 92 %, thermal 10 %/);
  assert.match(lines.join("\n"), /Stopped early: the game ended/);
  assert.equal(P.limitedShare({ pl1: 0.2, pl2: 0.5, thermal: 0.9 }), 0.5);
  assert.equal(P.limitedShare({}), null);
});

// ---- E. power tips ---------------------------------------------------------------------------------------------

const advice = (kind, over = {}) => ({
  kind, appid: "1091500", pl1_w: 25, suggest_w: kind === "headroom" ? 15 : kind === "raise" ? 30 : null, ac: false, pl1_max_ac: 40,
  seconds: 420, stats: { samples: 84, avg_package_w: 13.8, p90_package_w: 15.9, avg_gpu_busy_pct: 62, p90_gpu_busy_pct: 70,
    limited_share: 0.03, thermal_share: 0 }, ...over,
});

test("adviceLine for each kind, ≤ 80 with 3-digit values", () => {
  assert.equal(P.adviceLine(advice("headroom")), "GPU has headroom: 15 W would likely keep your fps (now 25 W)");
  assert.equal(P.adviceLine(advice("raise")), "Power-limited at 25 W: 30 W may give more fps");
  assert.equal(P.adviceLine(advice("plug")), "Power-limited at 25 W: plug in for up to 40 W");
  assert.equal(P.adviceLine(advice("cpu", { pl1_w: 40 })), "Power-limited at 40 W: a lower CPU speed cap leaves the GPU more");
  for (const k of ["headroom", "raise", "plug", "cpu"]) {
    const l = P.adviceLine(advice(k, { pl1_w: 152.5, suggest_w: 148.5, pl1_max_ac: 199.5 }));
    assert.ok(l.length <= 80, l);
  }
  assert.equal(P.adviceUsable(advice("headroom")), true);
  assert.equal(P.adviceUsable(advice("raise")), true);
  assert.equal(P.adviceUsable(advice("plug")), false);
  assert.equal(P.adviceUsable(advice("cpu")), false);
  assert.equal(P.adviceUsable(null), false);
});

test("adviceDetails: the measured numbers and that nothing changes until tapped", () => {
  const d = P.adviceDetails(advice("headroom")).join(" ");
  assert.match(d, /Over 7 min at 25 W: 13\.8 W on average \(90 % of the time under 15\.9 W\), GPU busy 62 %, held back by the power limit 3 % of the time\./);
  assert.match(d, /If fps drops, tap Undo or move the slider/);
  assert.match(d, /Nothing changes until you tap/);
});

// ---- A. VRR ----------------------------------------------------------------------------------------------------

test("vrrShown: only with vrr_safe true, hidden per kernel", () => {
  const r = { summary: ["DMC v2.33 loaded"], advice: [], vrr_safe: true, vrr_reason: "fixed", vrr_why: "the kernel has the variable-refresh fix (7.2.10 or later)", vrr_range_hz: null };
  assert.equal(D.vrrShown(r, "7.2.10", null), true);
  assert.equal(D.vrrShown(r, "7.2.10", "7.2.10"), false);
  assert.equal(D.vrrShown(r, "7.2.11", "7.2.10"), true);
  assert.equal(D.vrrShown({ ...r, vrr_safe: false }, "7.2.10", null), false);
  assert.equal(D.vrrShown({ ...r, vrr_safe: null }, "7.2.10", null), false);
  assert.equal(D.vrrShown({ summary: [], advice: [] }, "7.2.10", null), false);   // an older oxp3-tool
  assert.equal(D.vrrShown(null, "7.2.10", null), false);
  assert.equal(D.vrrShown({ ...r, vrr_reason: "no_firmware" }, "7.2.10", null), false);   // oxp3-tool's DMC line instead
  assert.equal(D.vrrShown(r, null, D.vrrKernelKey(null)), false);     // an unreadable kernel can be hidden too
  assert.equal(D.vrrKernelKey(""), "unknown");
  assert.equal(D.isVrrAdvice("Variable refresh (VRR) is safe on this kernel (x): turn it on"), true);
  assert.equal(D.isVrrAdvice("Display refresh: 144 Hz"), false);
  assert.equal(D.VRR_TIP_KEY, "vrrTip");
});

test("vrrDetails with and without a range", () => {
  const r = { summary: ["DMC v2.33 loaded"], advice: [], vrr_safe: true, vrr_reason: "fixed", vrr_why: "the kernel has the variable-refresh fix (7.2.10 or later)", vrr_range_hz: null };
  const a = D.vrrDetails(r);
  assert.equal(a.body[0], "This kernel is safe for variable refresh: the kernel has the variable-refresh fix (7.2.10 or later).");
  assert.match(a.body[1], /Settings > Display > Enable VRR\. Some Steam versions also show it in Quick Access > Performance\. "Allow tearing" is a separate switch/);
  assert.match(a.body[2], /\(40, 45, 50 fps\)/);
  assert.doesNotMatch(a.body[2], /repeats frames/);
  assert.match(a.body[3], /OLED .*\(Not checked on this screen yet\.\)/);
  assert.deepEqual(a.lines, ["DMC v2.33 loaded", "vrr_reason: fixed"]);
  const b = D.vrrDetails({ ...r, vrr_range_hz: [48, 144] });
  assert.match(b.body[2], /Below 48 fps the screen repeats frames, so keep the limit at 48 fps or above\./);
  assert.equal(D.vrrDetails({ summary: [], advice: [], vrr_safe: true }).body[0], "This kernel is safe for variable refresh.");
  assert.ok(D.VRR_LINE.length <= 80);
});

// ---- effect tags -----------------------------------------------------------------------------------------------

test("the batch's effect tags", () => {
  for (const id of ["power.preset", "power.low_battery", "power.low_battery_pct", "power.low_battery_games", "power.advisor", "power.advice_use"]) {
    assert.equal(EFFECTS[id], "now", id);
  }
  assert.equal(EFFECTS["power.selftest"], "idle");
  assert.equal(effectText(EFFECTS["power.selftest"]), "Only while no game runs");
  for (const id of ["power.measure", "power.dismiss", "power.vrr"]) assert.equal(id in EFFECTS, false, id);
});

// ---- the rows (source checks: they need Steam's React) ---------------------------------------------------------

test("the preset row is a horizontal Focusable of DialogButtons with no Custom button, written through the writer", () => {
  const s = src("components/PerfRows.tsx");
  const row = s.slice(s.indexOf("export const PresetRow"), s.indexOf("// ---- D. low battery"));
  assert.match(row, /<Focusable flow-children="horizontal"[^>]*>\s*\{PRESET_IDS\.map\(\(id\) => \(\s*<DialogButton /);
  assert.doesNotMatch(row, />\s*Custom\s*</);
  assert.doesNotMatch(row, /"custom"\)\s*}\s*>/);
  assert.match(row, /powerWriter\.write\(profileKey, slot, presetValues\(id, state\.range, slot, opts, caps\)\)/);
  assert.match(row, /EFFECTS\["power\.preset"\]/);
  assert.match(row, /"Turn on power control first\."/);
  assert.match(row, /UNDO_MS/);
  assert.doesNotMatch(s, /power_set\(/);
  // the Quick Power group (after the enable toggle) and the Power tab's editor
  const pc = src("components/PowerControls.tsx");
  const body = pc.slice(pc.indexOf("export const PowerBody"), pc.indexOf("export const PowerAlerts"));
  assert.ok(body.indexOf("<EnableToggle") < body.indexOf("<PresetRow") && body.indexOf("<PresetRow") < body.indexOf("<ValuesEditor"));
  const pw = src("pages/Power.tsx");
  const ed = pw.slice(pw.indexOf("const EditorSection"), pw.indexOf("const ConflictsSection"));
  assert.ok(ed.indexOf('label("Edit values for"') < ed.indexOf("<PresetRow") && ed.indexOf("<PresetRow") < ed.indexOf("<ValuesEditor"));
  assert.match(ed, /\{ data: "low", label: "Low battery" \}/);
});

test("the VRR row's dialog offers Don't show again and Close, hides per kernel; in Power group and Fixes", () => {
  const s = src("components/PerfRows.tsx");
  const row = s.slice(s.indexOf("export const VrrRow"), s.indexOf("// ---- E. power tips"));
  assert.match(row, /confirm\(\{ title: VRR_LABEL, ok: "Don't show again", cancel: "Close",/);
  assert.match(row, /remember\.set\(VRR_TIP_KEY, kernel\)/);
  assert.doesNotMatch(row, /EFFECTS\[/);
  assert.match(src("components/confirm.tsx"), /strCancelButtonText=\{o\.cancel \?\? "Cancel"\}/);
  const q = src("pages/Quick.tsx");
  const power = q.slice(q.indexOf('<Group id="power"'), q.indexOf('{showCpu && ('));
  assert.ok(power.indexOf("<PowerBody") < power.indexOf("<VrrRow status={status} />"), "the last row of the Power body");
  assert.match(src("pages/Fixes.tsx"), /<VrrRow status=\{status\} \/>/);
  assert.match(src("pages/Fixes.tsx"), /advice\.filter\(\(a\) => !isVrrAdvice\(a\)\)/);   // not said twice
});

test("the Power tip row is inside the game group, after Separate profile; Use N W has its tag, Dismiss none", () => {
  const q = src("pages/Quick.tsx");
  const game = q.slice(q.indexOf('<Group id="game"'), q.indexOf('<Group id="power"'));
  assert.ok(game.indexOf("<GameProfileToggle") > 0 && game.indexOf("<PowerTipRows") > game.indexOf("<GameProfileToggle"));
  const s = src("components/PerfRows.tsx");
  const tip = s.slice(s.indexOf("export const PowerTipRows"), s.indexOf("// ---- B. device check"));
  assert.match(tip, /EFFECTS\["power\.advice_use"\]/);
  assert.match(tip, /power_advice_dismiss\(app\.appid, x\.kind, x\.pl1_w\)/);
  assert.match(tip, /info\.options\.advisor \?\? true/);
  assert.match(tip, /state\.active\.slot !== "low"/);
  // the advice is read in memory (no sysfs) when the group opens and every 60 s while the panel shows
  assert.match(s, /const ADVICE_MS = 60000;/);
  assert.match(s, /useResource<PowerAdviceRes>\(key, loader, \{ skip: !visible, fresh: true \}\)/);
});

test("the device check: confirm with the idle tag, greyed reasons, results reload the power info", () => {
  const s = src("components/PerfRows.tsx");
  const dc = s.slice(s.indexOf("export const DeviceCheckSection"), s.indexOf("export const TimeWindowsRow"));
  assert.match(dc, /title: "Check power controls\?", ok: "Check", effect: EFFECTS\["power\.selftest"\]/);
  for (const t of ["Turn on power control first.", "Quit the game first.", "Power control is paused."]) assert.ok(dc.includes(`"${t}"`), t);
  assert.match(dc, /`Wait for \$\{running\.title\}\.`/);
  assert.match(dc, /power_measure\(game \? "game" : "idle"\)/);
  assert.match(dc, /afterJob\(r\.job\.id, \(j\) => \{ if \(j\.state === "done"\) invalidate\("power"\); \}\)/);
  const pw = src("pages/Power.tsx");
  assert.ok(pw.indexOf("<FirmwareSection") < pw.indexOf("<DeviceCheckSection"));
  assert.match(pw, /<TimeWindowsRow info=\{info\} \/>/);
  assert.match(src("components/JobView.tsx"), /shown\.kind === "oxp3-diagnose" && typeof shown\.result\?\.extra_path === "string"/);
});

test("the low-battery rows: status in the Quick Power group and on the Power tab, the three options with tags", () => {
  assert.match(src("components/PowerControls.tsx"), /<PowerStatusRows info=\{info\} state=\{s\} quick \/>\n\s*<LowBatteryRow state=\{s\} \/>/);
  assert.match(src("pages/Power.tsx"), /<LowBatteryRow state=\{state\} \/>/);
  const s = src("components/PerfRows.tsx");
  for (const id of ["power.low_battery", "power.low_battery_pct", "power.low_battery_games", "power.advisor"]) {
    assert.match(s, new RegExp(`EFFECTS\\["${id.replace(".", "\\.")}"\\]`), id);
  }
  assert.match(s, /min=\{LOW_SLIDER\.min\} max=\{LOW_SLIDER\.max\} step=\{LOW_SLIDER\.step\}/);
  assert.deepEqual({ ...P.LOW_SLIDER }, { min: 10, max: 40, step: 5 });
});

test("the four new calls are in api.ts and wrapped in backend.ts; power_set takes a Slot", () => {
  const api = src("api.ts");
  assert.match(api, /power_selftest = callable<\[\], JobStart>\("power_selftest"\)/);
  assert.match(api, /power_measure = callable<\[mode: "idle" \| "game"\], JobStart>\("power_measure"\)/);
  assert.match(api, /power_advice = callable<\[appid: string\], PowerAdviceRes>\("power_advice"\)/);
  assert.match(api, /power_advice_dismiss = callable<\[appid: string, kind: string, pl1_w: number\], Res>\("power_advice_dismiss"\)/);
  assert.match(api, /power_set = callable<\[key: string, slot: Slot, /);
  assert.match(src("types.ts"), /export type Slot = "main" \| "ac" \| "low";/);
});

test("fix-integrate: the power tip names the profile Use N W writes; low-slot rows say what runs", () => {
  assert.equal(P.adviceTarget("Hades", true, true), "Hades");
  assert.equal(P.adviceTarget("Hades", false, true), "a new profile for Hades");
  assert.equal(P.adviceTarget("Hades", true, false), "the Default profile");      // per-game off: Default
  assert.match(src("components/PerfRows.tsx"), /adviceTarget\(app\.name, !!info\.profiles\[app\.appid\], info\.options\.per_game\)/);
  // while the low-battery values run the header names the applied values, not the stored slot or a preset
  const s = { active: { slot: "low" }, applied_values: { ...P.EMPTY, pl1_w: 8 }, values: { ...P.EMPTY, pl1_w: 10 },
    now: { zones: [], pl1_w: 25, pl2_w: 52 }, range: { gpu_min: 300, gpu_max: 2300 } };
  assert.equal(Q.summaryValues(s, { ...P.EMPTY, pl1_w: 10 }).pl1_w, 8);
  const main = { ...s, active: { slot: "main" } };
  const edited = { ...P.EMPTY, pl1_w: 10 };
  assert.equal(Q.summaryValues(main, edited), edited);
  const q = src("pages/Quick.tsx");
  assert.match(q, /summaryValues\(s, vals\)/);
  assert.match(q, /info && !lowRuns \? presetOf\(/);
  assert.match(src("components/PerfRows.tsx"), /\{slot === "low" && \(/);
  assert.doesNotMatch(src("components/PerfRows.tsx"), /[^t] values for: Low battery/);
});
