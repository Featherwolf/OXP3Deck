// Tests for src/updates.ts and the wiring of the daily update checks (ROADMAP T1-9 + C-5). Run from the repository
// root: node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const U = await import("../../src/updates.ts");
const { MAX_LINE } = await import("../../src/text.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

const inst = (version, bundled) => ({ installed: true, path: "/usr/local/bin/oxp3-tool", version, json_ok: true,
  min_version: "0.4.2", bundled_version: bundled });
const oxp3 = (over = {}) => ({ ok: true, error: null, installed: "0.4.2", bundled: "0.4.2", online: "0.4.3",
  online_commit: null, update: "online", checked_at: 1000, ...over });
const xess = (over = {}) => ({ ok: true, error: null, installed: "20261031", latest: "20261104", update_available: true,
  checked_at: 1000, note: null, ...over });
const auto = (over = {}) => ({ on: true, checked_at: 1000, install_url: "https://x/OXP3Deck.zip", oxp3: oxp3(), xess: xess(),
  plugin: null, ...over });
const xsum = { installed: true, version: "20261031", status: "ok", line: null, live: true, relogin_needed: false };

test("an automatic check fills its cache only for what is installed now, and never over a later tap", () => {
  assert.deepEqual(U.oxp3Fill(auto(), inst("0.4.2", "0.4.2")), oxp3());
  assert.deepEqual(U.oxp3Fill(auto(), inst("0.4.2", "0.4.2"), 999), oxp3());
  assert.equal(U.oxp3Fill(auto(), inst("0.4.2", "0.4.2"), 1000), null);       // the cache is as new or newer
  assert.equal(U.oxp3Fill(auto(), inst("0.4.3", "0.4.2")), null);             // updated since the check
  assert.equal(U.oxp3Fill(auto(), inst("0.4.2", "0.4.4")), null);             // the plugin was updated since
  assert.equal(U.oxp3Fill(auto({ oxp3: oxp3({ ok: false }) }), inst("0.4.2", "0.4.2")), null);
  assert.equal(U.oxp3Fill(null, inst("0.4.2", "0.4.2")), null);
  assert.deepEqual(U.xessFill(auto(), xsum), xess());
  assert.equal(U.xessFill(auto(), { ...xsum, version: "20261104" }), null);
  assert.equal(U.xessFill(auto(), xsum, 2000), null);
  assert.deepEqual(U.xessFill(auto({ xess: xess({ installed: null, update_available: false }) }), { ...xsum, installed: false }),
    xess({ installed: null, update_available: false }));
});

test("Device fixes says Update available for a newer bundled copy or a GitHub update of this install", () => {
  assert.equal(U.oxp3UpdateFlag(inst("0.4.2", "0.4.2"), oxp3(), false), true);
  assert.equal(U.oxp3UpdateFlag(inst("0.4.3", "0.4.2"), oxp3(), false), false);
  assert.equal(U.oxp3UpdateFlag(inst("0.4.2", "0.4.2"), oxp3({ update: null }), false), false);
  assert.equal(U.oxp3UpdateFlag(inst("0.4.2", "0.4.2"), undefined, true), true);
});

test("the bundled oxp3-tool is a one-tap notice, never offered when it is not newer", () => {
  const n = U.bundledNotice(inst("0.4.2", "0.4.10"));
  assert.equal(n.label, "oxp3-tool 0.4.10 bundled");
  assert.equal(n.button, "Install");
  assert.match(n.body, /Apply again/);
  assert.match(n.body, /Asks first/);
  assert.ok(n.line.length <= MAX_LINE);
  assert.equal(U.bundledNotice(inst("0.4.10", "0.4.9")), null);
  assert.equal(U.bundledNotice(inst("0.4.2", "0.4.2")), null);
  assert.equal(U.bundledNotice(inst("0.4.2", null)), null);
  assert.equal(U.bundledNotice({ ...inst(null, "0.4.3"), installed: false }), null);   // the not-installed alert covers it
  assert.match(U.installedToast("0.4.3").body, /Xbox key/);
});

test("helpers from an older oxp3-tool are offered to apply again", () => {
  const fix = (id, state, notes) => ({ id, title: id, state, notes, group: "controller", level: "recommended", summary: "",
    takes_effect: "now", applied_at: null, options: {}, pending: null });
  const st = { fixes: [
    fix("xbox-key", "applied", ["The xbox-key helper is from an older oxp3-tool and lacks this version's fixes; run …"]),
    fix("buttons", "applied", ["installed by an older oxp3-tool; run `sudo oxp3-tool apply buttons` to update it"]),
    fix("gyro", "applied", ["fine"]), fix("old", "n/a", ["installed by an older oxp3-tool"]),
  ] };
  const stale = U.staleHelpers(st);
  assert.deepEqual(stale.map((f) => f.id), ["xbox-key", "buttons"]);
  const h = U.helpersNotice(stale);
  assert.equal(h.button, "Apply again (2)");
  assert.match(h.body, /xbox-key, buttons/);
  assert.ok(h.line.length <= MAX_LINE);
  assert.equal(U.helpersNotice([]), null);
  assert.deepEqual(U.staleHelpers(null), []);
});

test("a newer OXP3 Deck: a notice with Copy install URL, gone once it runs", () => {
  const u = auto({ plugin: { current: "0.5.0", latest: "0.6.0-rc.1", update: true, checked_at: 1000 } });
  const n = U.pluginNotice(u, "0.5.0");
  assert.equal(n.label, "OXP3 Deck 0.6.0-rc.1 available");
  assert.equal(n.button, "Copy install URL");
  assert.match(n.body, /Install Plugin from URL/);
  assert.ok(n.line.length <= MAX_LINE);
  assert.equal(U.pluginNotice(u, "0.6.0"), null);
  assert.equal(U.pluginNotice(auto({ plugin: { ...u.plugin, update: false } }), "0.5.0"), null);
  assert.equal(U.anyNotice({ oxp3: inst("0.4.2", "0.4.2"), updates: u, plugin_version: "0.5.0" }, null), true);
  assert.equal(U.anyNotice({ oxp3: inst("0.4.2", "0.4.2"), updates: auto(), plugin_version: "0.5.0" }, null), false);
  assert.equal(U.anyNotice({ oxp3: inst("0.4.2", "0.4.3"), updates: null, plugin_version: "0.5.0" }, null), true);
});

test("the switch's texts are short", () => {
  for (const on of [true, false]) assert.ok(U.autoLine(on).length <= MAX_LINE);
  const d = U.autoDetails(auto(), () => "10:00");
  assert.match(d.body, /Nothing installs without a tap/);
  assert.deepEqual(d.lines, ["last check: 10:00"]);
  assert.deepEqual(U.autoDetails(null, () => "x").lines, ["last check: none yet"]);
});

test("wiring: the caches are filled from the overview; installs only from a tap", () => {
  const rows = src("components/UpdateRows.tsx");
  assert.match(rows, /put\(CHECK_KEYS\.oxp3, oc, u\.oxp3\?\.checked_at\)/);
  assert.match(rows, /installOxp3\("bundled"/);                 // the existing confirm and install job
  assert.match(rows, /set_setting\("update_auto", want\)/);
  assert.match(rows, /EFFECTS\["updates\.auto"\]/);
  assert.doesNotMatch(rows, /oxp3_install\(/);                  // never straight to the job without the confirm
  for (const page of ["pages/Quick.tsx", "pages/Updates.tsx"]) assert.match(src(page), /useAutoChecks\(o\)/, page);
  assert.match(src("pages/Updates.tsx"), /<AutoCheckToggle /);
  assert.match(src("pages/Quick.tsx"), /oxp3UpdateFlag\(/);
  assert.equal(U.CHECK_KEYS.oxp3, "manual:oxp3-check");
  assert.equal(U.CHECK_KEYS.xess, "manual:xess-check");
  assert.match(src("store.ts"), /export const filledAt/);
});
