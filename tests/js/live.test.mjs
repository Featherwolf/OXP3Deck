// Tests for src/live.ts. Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./tsresolve.mjs";

const { batteryText, gpuClockText, liveLine, liveRows, minutesText, whySlow } = await import("../../src/live.ts");

const full = {
  t: 10, package_w: 18.44,
  battery: { status: "Discharging", percent: 71, draw_w: 17.9, time_left_min: 190, time_to_full_min: null },
  cpu_temp_c: 62.4,
  gpu: { busy_pct: 87.2, cur_mhz: 1500, act_mhz: 1450, reasons: [] },
  throttle: { cpu_ms: 0, cpu: false, gpu: [] },
  fan_rpm: 3100,
};
const empty = { t: 1, package_w: null, battery: null, cpu_temp_c: null, gpu: null, throttle: { cpu_ms: null, cpu: false, gpu: [] }, fan_rpm: null };

test("liveLine: every part, nulls left out, at most 80 characters", () => {
  assert.equal(liveLine(full), "18.4 W · 62 °C · GPU 87 % · 3 h 10 min left");
  assert.equal(liveLine({ ...full, package_w: null, gpu: null }), "62 °C · 3 h 10 min left");
  assert.equal(liveLine(empty), "Nothing to read on this system.");
  assert.equal(liveLine(null), "Reading…");
  const charging = { ...full, battery: { ...full.battery, status: "Charging", time_left_min: null, time_to_full_min: 40 } };
  assert.equal(liveLine(charging), "18.4 W · 62 °C · GPU 87 % · full in 40 min");
  const huge = { ...full, package_w: 123456789.12, cpu_temp_c: 1e12, battery: { ...full.battery, time_left_min: 1e9 } };
  assert.ok(liveLine(huge).length <= 80);
  for (const l of [full, empty, charging]) assert.ok(liveLine(l).length <= 80);
});

test("whySlow: CPU too hot, the GPU's reasons in words, else not held back", () => {
  assert.equal(whySlow(full), "Not held back");
  assert.equal(whySlow({ ...full, throttle: { cpu_ms: 40, cpu: true, gpu: [] } }), "CPU too hot");
  assert.equal(whySlow({ ...full, throttle: { cpu_ms: 0, cpu: false, gpu: ["pl1"] } }), "GPU power-limited");
  assert.equal(whySlow({ ...full, throttle: { cpu_ms: 9, cpu: true, gpu: ["thermal"] } }), "CPU too hot; GPU thermal-limited");
  assert.equal(whySlow(null), "Not known yet");
});

test("the rows and their parts", () => {
  assert.equal(minutesText(45), "45 min");
  assert.equal(minutesText(61), "1 h 1 min");
  assert.equal(minutesText(null), null);
  assert.equal(batteryText({ status: "Full", percent: 100, draw_w: null, time_left_min: null, time_to_full_min: null }), "battery 100 %");
  assert.equal(gpuClockText(full.gpu), "requested 1500 MHz, running 1450 MHz");
  assert.equal(gpuClockText(null), null);
  const rows = Object.fromEntries(liveRows(full).map((r) => [r.label, r.value]));
  assert.equal(rows["Package power"], "18.4 W");
  assert.equal(rows.Battery, "71 % · on battery · 17.9 W · 3 h 10 min left");
  assert.equal(rows.Fan, "3100 RPM");
  assert.deepEqual(liveRows(empty).map((r) => r.label), ["Held back"]);
});
