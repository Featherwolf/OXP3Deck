// Tests for src/conflicts.ts: the conflict texts against power.py's CONFLICTS and FIXABLE (read from the file).
// Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cameBackText, controls, explainBody, fixable, FIXABLE, fixConfirm, fixedLines, friendlyName, lockedLine, MASKABLE,
  oneLine, undoConfirm,
} from "../../src/conflicts.ts";

const py = readFileSync(new URL("../../py_modules/oxp3deck/power.py", import.meta.url), "utf8");

/** The ids of power.py's CONFLICTS table (its keys, one per entry line). */
const conflictIds = () => {
  const body = py.slice(py.indexOf("CONFLICTS = {"), py.indexOf("\n}\n", py.indexOf("CONFLICTS = {")));
  return [...body.matchAll(/^ {4}"([a-z0-9_-]+)": \(/gm)].map((m) => m[1]);
};

/** power.py's FIXABLE as {id: [units]}, or null while the backend has none yet. */
const pyFixable = () => {
  const at = py.indexOf("FIXABLE = {");
  if (at < 0) return null;
  const body = py.slice(at, py.indexOf("}", at) + 1);
  return Object.fromEntries([...body.matchAll(/"([a-z0-9_-]+)":\s*\(([^)]*)\)/g)]
    .map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((u) => u[1])]));
};

const row = (id, extra = {}) => ({ id, name: id, kind: "blocks", ignorable: false, ignored: false, why: `${id} is running: it sets things`,
  fix: "sudo systemctl disable --now x.service", fix_units: FIXABLE[id] ?? [], fixed: null, ...extra });

test("every conflict id of power.py has a friendly name and a plain one-liner", () => {
  const ids = [...conflictIds(), "unknown"];
  assert.ok(ids.length >= 11, ids.join(","));
  for (const id of ids) {
    assert.ok(friendlyName(id, id === "powercontrol" ? "PowerTools" : null), id);
    const line = oneLine(row(id));
    assert.ok(line.length > 0 && line.length <= 80, `${id}: ${line}`);
    assert.doesNotMatch(line, /sudo|systemctl|\//, `${id}: ${line}`);
  }
  assert.equal(friendlyName("powercontrol", "PowerTools"), "PowerTools");
  assert.equal(friendlyName("ppd"), "Power Profiles");
  assert.equal(friendlyName("somethingnew", "New thing"), "New thing");
});

test("an unknown id falls back to the backend's row, still one short line", () => {
  const line = oneLine({ id: "future", why: "future-daemon is running: it rewrites the power limits every second and more and more and more and more" });
  assert.ok(line.length <= 80, line);
  assert.match(line, /^It rewrites/);
});

test("FIXABLE is power.py's whitelist", (t) => {
  const p = pyFixable();
  if (!p) { t.skip("power.py has no FIXABLE yet"); return; }
  assert.deepEqual(Object.fromEntries(Object.entries(FIXABLE).sort()), Object.fromEntries(Object.entries(p).sort()));
});

/** power.py's MASKABLE as a sorted list. */
const pyMaskable = () => {
  const at = py.indexOf("MASKABLE = frozenset({");
  return [...py.slice(at, py.indexOf("})", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
};

test("MASKABLE is power.py's, and only FIXABLE units", () => {
  assert.deepEqual([...MASKABLE].sort(), pyMaskable());
  const all = new Set(Object.values(FIXABLE).flat());
  for (const u of MASKABLE) assert.ok(all.has(u), u);
  for (const id of ["powerstation", "oxp3-tdp-sync", "onex3-tdp"]) for (const u of FIXABLE[id]) assert.ok(!MASKABLE.has(u), u);
});

test("every FIXABLE id has a Fix dialog naming each unit, saying Undo; masks only MASKABLE units and says so", () => {
  for (const id of Object.keys(FIXABLE)) {
    assert.ok(fixable(id));
    const d = fixConfirm(row(id));
    assert.ok(d.title.endsWith("?"), d.title);
    assert.match(d.text, /Undo/, id);
    assert.match(d.text, /Nothing is (uninstalled|deleted)/, id);
    for (const u of FIXABLE[id]) assert.ok(d.lines.some((l) => l.includes(u)), `${id}: ${u}`);
    const masks = FIXABLE[id].some((u) => MASKABLE.has(u));
    assert.deepEqual(d.lines.map((l) => l.split(" ")[2]), masks ? ["stop", "disable", "mask"] : ["stop", "disable"], id);
    for (const l of d.lines) {
      assert.match(l, /^systemctl --no-ask-password (stop|disable|mask) -- /);
      assert.doesNotMatch(l, /unmask|--now|--runtime|kill/);
      if (l.split(" ")[2] === "mask") for (const u of l.split(" -- ")[1].split(" ")) assert.ok(MASKABLE.has(u), u);
    }
    assert.equal(d.ok, "Turn it off");
    if (masks) {
      assert.match(d.text, /mask (it|them): while masked, nothing can start (it|them) again/, id);
      assert.match(d.text, /Undo unmasks (it|them)/, id);
    } else {
      assert.doesNotMatch(`${d.title} ${d.text}`, /\bmask/i, id);
    }
    assert.doesNotMatch(d.text, /may start again/, id);
  }
  for (const id of ["ppd", "tuned"]) {
    const t = fixConfirm(row(id)).text;
    assert.match(t, /What stops working: the power mode switch in Desktop Mode \(KDE's power profiles\)/, id);
    assert.match(t, /profile switching by Steam/, id);
  }
  assert.match(fixConfirm(row("ppd")).text, /game-performance/);
  assert.ok(!fixable("hhd") && !fixable("simpledeckytdp") && !fixable("steamos-remote"));
});

test("the Fix dialog uses the units the backend offers now (only tuned-ppd loaded)", () => {
  const d = fixConfirm(row("tuned", { fix_units: ["tuned-ppd.service"] }));
  assert.deepEqual(d.lines, ["systemctl --no-ask-password stop -- tuned-ppd.service", "systemctl --no-ask-password disable -- tuned-ppd.service",
    "systemctl --no-ask-password mask -- tuned-ppd.service"]);
});

test("the Fix dialog lists only what the backend's fix_plan runs, and says so", () => {
  const units = ["power-profiles-daemon.service"];
  const stopOnly = fixConfirm(row("ppd", { fix_plan: { disable: [], stop: units, mask: units } }));
  assert.deepEqual(stopOnly.lines, ["systemctl --no-ask-password stop -- power-profiles-daemon.service",
    "systemctl --no-ask-password mask -- power-profiles-daemon.service"]);
  assert.doesNotMatch(stopOnly.text, /keep it from starting at boot/);
  assert.match(stopOnly.text, /stop power-profiles-daemon and mask it/);
  const ps = ["powerstation.service"];
  const psStop = fixConfirm(row("powerstation", { fix_plan: { disable: [], stop: ps, mask: [] } }));
  assert.deepEqual(psStop.lines, ["systemctl --no-ask-password stop -- powerstation.service"]);
  assert.match(psStop.text, /not set to start at boot/);
  const psBoot = fixConfirm(row("powerstation", { fix_plan: { disable: ps, stop: [], mask: [] } }));
  assert.deepEqual(psBoot.lines, ["systemctl --no-ask-password disable -- powerstation.service"]);
  assert.match(psBoot.text, /not running now/);
  const bootOnly = fixConfirm(row("thermald", { fix_plan: { disable: ["thermald.service"], stop: [], mask: ["thermald.service"] } }));
  assert.deepEqual(bootOnly.lines, ["systemctl --no-ask-password disable -- thermald.service", "systemctl --no-ask-password mask -- thermald.service"]);
  assert.match(bootOnly.text, /keep it from starting at boot and mask it/);
  const both = fixConfirm(row("ppd", { fix_plan: { disable: units, stop: units, mask: units } }));
  assert.match(both.text, /stop power-profiles-daemon, keep it from starting at boot and mask it/);
  assert.deepEqual(fixConfirm(row("ppd", { fix_plan: null })).lines.map((l) => l.split(" ")[2]), ["stop", "disable", "mask"]);
  // an older backend's plan without mask: the MASKABLE units of the row
  assert.deepEqual(fixConfirm(row("ppd", { fix_plan: { disable: [], stop: units } })).lines.map((l) => l.split(" ")[2]), ["stop", "mask"]);
});

test("the Fix dialog promises energy preference and CPU boost only while power control is on", () => {
  for (const id of ["ppd", "tuned", "intel_lpmd"]) {
    assert.doesNotMatch(fixConfirm(row(id)).text, /energy preference/, id);
    assert.match(fixConfirm(row(id), true).text, /can set energy preference and CPU boost/, id);
  }
  assert.doesNotMatch(fixConfirm(row("thermald"), true).text, /energy preference/);
});

test("the Undo dialog unmasks what OXP3 Deck masked first, then enable / start", () => {
  const rec = { id: "ppd", name: "power-profiles-daemon", at: 1, came_back: false, units: [
    { unit: "power-profiles-daemon.service", was_enabled: "disabled", was_active: true, was_masked: false }] };
  const d = undoConfirm(rec, "");
  assert.deepEqual(d.lines, ["systemctl --no-ask-password unmask -- power-profiles-daemon.service",
    "systemctl --no-ask-password start -- power-profiles-daemon.service"]);
  assert.match(d.text, /unmasks and turns back on/);
  const planted = undoConfirm({ ...rec, id: "powerstation", units: [{ unit: "powerstation.service", was_enabled: "enabled", was_active: false, was_masked: false }] }, "");
  assert.deepEqual(planted.lines, ["systemctl --no-ask-password enable -- powerstation.service"]);   // never unmasked
  assert.deepEqual(fixedLines(rec), ["power-profiles-daemon.service: was disabled, running, not masked (OXP3 Deck masked it)"]);
});

test("the Undo dialog of an older record (no was_masked) turns on exactly what was on: enable / start only", () => {
  const rec = { id: "tuned", name: "tuned", at: 1, came_back: false, units: [
    { unit: "tuned-ppd.service", was_enabled: "enabled", was_active: true },
    { unit: "tuned.service", was_enabled: "static", was_active: false },
  ] };
  const d = undoConfirm(rec, "4 Nov 18:34");
  assert.equal(d.title, "Turn TuneD back on?");
  assert.match(d.text, /turned off \(4 Nov 18:34\)\./);
  assert.doesNotMatch(undoConfirm(rec, "14:30").text, /on 14:30/);
  assert.match(d.text, /energy preference and CPU boost again/);
  assert.deepEqual(d.lines, ["systemctl --no-ask-password enable -- tuned-ppd.service", "systemctl --no-ask-password start -- tuned-ppd.service"]);
  for (const l of d.lines) assert.match(l, /^systemctl --no-ask-password (enable|start) -- /);
  const none = undoConfirm({ ...rec, units: [{ unit: "tuned.service", was_enabled: "disabled", was_active: false }] }, "");
  assert.deepEqual(none.lines, []);
  assert.match(undoConfirm({ id: "thermald", name: "thermald", units: [] }, "").text, /the power limits again/);
  assert.deepEqual(fixedLines(rec), ["tuned-ppd.service: was enabled, running", "tuned.service: was static, not running"]);
});

test("came back: its own line, the Details say so, Fix again is offered by the row", () => {
  const fixed = { id: "ppd", name: "power-profiles-daemon", at: 1, units: [], came_back: true };
  assert.equal(oneLine(row("ppd", { fixed })), cameBackText("ppd"));
  assert.match(cameBackText("ppd"), /power mode or a game launcher/);
  assert.match(cameBackText("powerstation"), /Bazzite update/);
  assert.match(explainBody(row("ppd", { fixed })).body[0], /Fix again/);
  for (const id of ["ppd", "thermald", "x"]) assert.ok(cameBackText(id).length <= 80);
  const masked = { ...fixed, units: [{ unit: "power-profiles-daemon.service", was_enabled: "enabled", was_active: true, was_masked: false }] };
  assert.equal(oneLine(row("ppd", { fixed: masked, fix_units: [] })), "It's running even though OXP3 Deck masked it.");
  const body = explainBody(row("ppd", { fixed: masked, fix_units: [] })).body[0];
  assert.match(body, /did not stop, or something started it outside systemd/);
  assert.match(body, /"Undo" unmasks it/);
  assert.doesNotMatch(body, /Fix again/);
});

test("Details: what it is, what it costs, Fix for me when offered, the manual way as lines, mask only via Fix for me", () => {
  for (const id of [...conflictIds(), "unknown"]) {
    const e = explainBody(row(id));
    assert.ok(e.body.length >= 1, id);
    assert.equal(e.linesTitle, "Do it yourself:");
    assert.deepEqual(e.lines, ["sudo systemctl disable --now x.service"]);
    assert.equal(e.body.some((b) => /Fix for me/.test(b)), !!FIXABLE[id], id);
    const masks = (FIXABLE[id] ?? []).some((u) => MASKABLE.has(u));
    const said = e.body.filter((b) => /\bmask/i.test(b));
    assert.ok(said.every((b) => /Fix for me/.test(b)), id);      // no "mask it yourself" advice
    assert.equal(said.length, masks ? 1 : 0, id);
  }
  assert.match(explainBody(row("thermald")).body.join(" "), /heat limit and the fan/);
  // the manual way: only a command, cut before its reason; prose the body already says is not repeated
  const lines = (id, fix) => explainBody(row(id, { fix })).lines;
  assert.deepEqual(lines("thermald", "sudo systemctl disable --now thermald.service: on this CPU it rewrites the limit. More"),
    ["sudo systemctl disable --now thermald.service"]);
  assert.deepEqual(lines("powerstation", "sudo systemctl disable --now powerstation.service. On Bazzite, it"),
    ["sudo systemctl disable --now powerstation.service"]);
  assert.deepEqual(lines("intel_lpmd", "sudo systemctl disable --now intel_lpmd.service (CachyOS enables it)"),
    ["sudo systemctl disable --now intel_lpmd.service"]);
  assert.deepEqual(lines("hhd", "turn off TDP control in Handheld Daemon's settings, then \"I've handled it\""), []);
  assert.deepEqual(lines("simpledeckytdp", "Decky → Settings → Plugins: disable or uninstall SimpleDeckyTDP"), []);
  assert.match(explainBody(row("hhd")).body.join(" "), /does not stop it/);
});

test("controls and lockedLine", () => {
  assert.equal(controls("intel_lpmd"), "energy preference and CPU boost");
  assert.equal(controls("powerstation"), "the power limits");
  assert.equal(lockedLine(["Power Profiles"]), "Locked by Power Profiles.");
  assert.equal(lockedLine([]), "Locked by another program.");
});

test("the Fix for me and Undo dialogs carry their effect tag (Now)", () => {
  assert.equal(fixConfirm({ id: "ppd", name: "power-profiles-daemon", fix_units: ["power-profiles-daemon.service"] }).effect, "now");
  assert.equal(undoConfirm({ id: "ppd", name: "x", units: [] }, "").effect, "now");
});
