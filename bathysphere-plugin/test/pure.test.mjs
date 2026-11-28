// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Unit tests of the pure modules (ported rules of the original): text, profiles and rules, presets,
// low battery, conflicts, the advisor, XeSS parsing and commands, game advice, launch-option lines,
// one-run logging, automatic setup plans, oxp3-tool state and commands, update parsing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as P from "../.test-out/pure.mjs";

const catalog = JSON.parse(readFileSync(new URL("../assets/oxp3-tool-catalog.json", import.meta.url), "utf8"));

test("one-line rule counts scalar values and cuts at a sentence (A9)", () => {
  assert.equal(P.firstSentence("The fan went back to Auto. It got hot at 90 °C."), "The fan went back to Auto.");
  assert.equal(P.firstSentence("Short."), "Short.");
  const long = "word ".repeat(40);
  assert.ok([...P.firstSentence(long)].length <= 80);
  assert.ok(P.firstSentence(long).endsWith("…"));
  assert.equal(P.fit("🙂".repeat(100), 10).length > 0, true);
  assert.equal([...P.fit("🙂".repeat(100), 10)].length, 10);
  assert.ok(P.fitsOneLine("All fine."));
  const d = P.details("t".repeat(100), "x".repeat(10000), Array(40).fill("y".repeat(300)));
  assert.ok([...d.title].length <= 80);
  assert.ok(new TextEncoder().encode(d.body).length <= 4096);
  assert.equal(d.lines.length, 32);
  assert.ok(d.lines.every((l) => [...l].length <= 200));
});

const caps = {
  boost: { modes: ["firmware", "follow", "manual"], offsetMax: 47 },
  epp: { types: ["all", "p", "e", "lpe"], available: ["default", "performance", "balance_performance", "balance_power", "power"] },
  cpuLimits: { types: ["p", "e", "lpe"] },
  socBalance: { balance: 3, offset: 0 },
  gpuRange: { floorMhz: 100, ceilMhz: 2300 },
  fan: { modes: ["auto", "quiet", "max"] },
  chargeBehaviour: { available: ["auto", "inhibit-charge-awake"] },
  tdpW: 20,
  runFromCharger: false,
};

const data = (over = {}) => P.normPower({ enabled: true, ...over });

test("power data is normalised field by field (A14, power.py _norm_*)", () => {
  const d = P.normPower({ enabled: "yes", options: { lowPct: 33, perGame: "x" }, profiles: { default: { main: { boostW: 999, epp: "bad value!", cpuMaxPct: 50, capP: 3000 } }, abc: {}, 570: { name: "Dota", main: {} } } });
  assert.equal(d.enabled, false);
  assert.equal(d.options.lowPct, 20);
  assert.equal(d.options.perGame, true);
  assert.equal(d.profiles.default.main.boostW, null);
  assert.equal(d.profiles.default.main.epp, null);
  assert.equal(d.profiles.default.main.cpuMaxPct, 50);
  assert.equal(d.profiles.default.main.capP, null, "speed cap and per-core caps are exclusive");
  assert.deepEqual(Object.keys(d.profiles).sort(), ["570", "default"]);
});

test("rules: manual boost, follow offsets per power source, gpu range, epp all, fan (C3, C4, C5, C7, E1)", () => {
  const d = data({ profiles: { default: { main: { follow: true, gpuMaxMhz: 1800, epp: "balance_power", fan: "quiet" } } } });
  const { rules } = P.buildRules(d, caps);
  const def = rules.find((r) => r.id === "default");
  assert.deepEqual(def.when, {});
  assert.deepEqual(def.set.boost, { mode: "follow", offsetW: 5 });
  assert.deepEqual(def.set.gpuRange, { minMhz: 100, maxMhz: 1800 });
  assert.deepEqual(def.set.epp, { all: "balance_power" });
  assert.equal(def.set.fan, "quiet");
  const ac = rules.find((r) => r.id === "ac");
  assert.deepEqual(ac.when, { power: "ac" });
  assert.deepEqual(ac.set.boost, { mode: "follow", offsetW: 10 }, "+50 % plugged in");
  const manual = P.buildRules(data({ profiles: { default: { main: { boostW: 25 } } } }), caps).rules.find((r) => r.id === "default");
  assert.deepEqual(manual.set.boost, { mode: "manual", watts: 25 });
});

test("rules: per-type EPP never with all; energy mode when EPP is not available (C7, C12)", () => {
  const per = P.ruleSet({ ...P.EMPTY, epp: "power", eppP: "performance" }, "battery", caps);
  assert.deepEqual(per.epp, { p: "performance", e: "power", lpe: "power" });
  const noAll = P.ruleSet({ ...P.EMPTY, epp: "power" }, "battery", { ...caps, epp: { types: ["p", "e"], available: ["power"] } });
  assert.deepEqual(noAll.epp, { p: "power", e: "power" });
  const energy = P.ruleSet({ ...P.EMPTY, epp: "balance_power" }, "battery", { ...caps, epp: undefined, energy: { available: ["power-saver", "balanced", "performance"] } });
  assert.equal(energy.energy, "power-saver");
  assert.equal(energy.epp, undefined);
});

test("rules: CPU cap or per-core caps; minimum speed only in plugged-in rules (C9, C10, C11, C13)", () => {
  const d = data({ profiles: { default: { main: { cpuMaxPct: 60, cpuMinPct: 40, socBalance: 4 } } } });
  const { rules } = P.buildRules(d, caps);
  assert.deepEqual(rules.find((r) => r.id === "default").set.cpuLimits, { maxPerfPct: 60 });
  assert.deepEqual(rules.find((r) => r.id === "ac").set.cpuLimits, { maxPerfPct: 60, minPerfPct: 40 });
  assert.deepEqual(rules.find((r) => r.id === "default").set.socBalance, { balance: 4, offset: 0 });
  const capsRule = P.ruleSet({ ...P.EMPTY, capP: 3000, capLpe: 1200 }, "battery", caps);
  assert.deepEqual(capsRule.cpuLimits, { coreTypeMaxMhz: { p: 3000, lpe: 1200 } });
});

test("rules: games, split AC, low battery, games on low battery, placeholders, the 64-rule limit (C15–C17, C34)", () => {
  const games = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(1000 + i), { name: `G${i}`, main: { boostW: 20 }, at: i }]));
  const d = data({ options: { splitAc: true, lowBattery: true, lowPct: 20, lowGames: true }, profiles: { default: { main: {} }, ...games } });
  const { rules, left } = P.buildRules(d, caps);
  assert.ok(rules.length <= P.MAX_RULES);
  assert.ok(left.length > 0, "the oldest game profiles are left out");
  assert.ok(left.includes("1000"));
  assert.equal(rules.find((r) => r.id === "default"), undefined, "an empty default needs no rule");
  assert.deepEqual(rules.find((r) => r.id === "ac").set, { fan: "auto" }, "an empty AC slot still wins over default");
  const low = rules.find((r) => r.id === "low");
  assert.deepEqual(low.when, { power: "battery", batteryBelow: 20 }, "hostd matches batteryBelow on AC too, so the rule names the battery");
  assert.deepEqual(low.set.boost, { mode: "manual", watts: 15 });
  assert.deepEqual(low.set.epp, { all: "balance_power" });
  const g = rules.find((r) => r.id === "app-1039");
  assert.deepEqual(g.when, { app: 1039 });
  assert.ok(rules.find((r) => r.id === "app-1039-ac"));
  assert.deepEqual(rules.find((r) => r.id === "app-1039-low").when, { app: 1039, power: "battery", batteryBelow: 20 });
  const off = P.buildRules(data({ options: { perGame: false }, profiles: { default: { main: {} }, 570: { main: { boostW: 30 } } } }), caps);
  assert.ok(!off.rules.some((r) => r.id.startsWith("app-")), "per-game off leaves game rules out");
  const rfc = P.buildRules(data({ profiles: { default: { main: { boostW: 20 } } } }), { ...caps, runFromCharger: true });
  assert.ok(rfc.rules.every((r) => r.set.chargeBehaviour === "inhibit-charge-awake"), "Run from charger is in every rule");
});

test("low battery merge never raises a limit (power.py _merge_low)", () => {
  const m = P.mergeLow({ ...P.EMPTY, boostW: 12, cpuMaxPct: 70, epp: "performance", eppP: "performance" }, { ...P.EMPTY, boostW: 15, cpuMaxPct: 50, epp: "power" }, 20);
  assert.equal(m.boostW, 12);
  assert.equal(m.cpuMaxPct, 50);
  assert.equal(m.epp, "power");
  assert.equal(m.eppP, null);
  const f = P.mergeLow({ ...P.EMPTY, follow: true }, P.BATTERY_LOW, 10);
  assert.equal(f.follow, true, "following at 10 W gives 13 W, below the low slot's 15 W");
  assert.equal(f.boostW, null);
});

test("presets inside the device's ranges and matching (C33)", () => {
  const r = { tdpMin: 5, tdpMax: 35, boostMin: 5, boostMax: 52 };
  assert.deepEqual(P.presetNumbers("battery", r), { tdp: 10, boostW: 15 });
  assert.deepEqual(P.presetNumbers("max", r), { tdp: 35, boostW: 52 });
  assert.deepEqual(P.presetNumbers("performance", r), { tdp: 28, boostW: null });
  assert.equal(P.presetOf({ ...P.EMPTY, boostW: 25, epp: "balance_performance" }, 17, r, true), "balanced");
  assert.equal(P.presetOf({ ...P.EMPTY, boostW: 26 }, 17, r, true), "custom");
  assert.equal(P.presetOf(P.EMPTY, 17, r, true), "default");
});

test("rule ids map back to profiles; sameRules ignores follow offsets", () => {
  assert.deepEqual(P.ruleTarget("app-570-ac"), { key: "570", slot: "ac" });
  assert.deepEqual(P.ruleTarget("low"), { key: "default", slot: "low" });
  assert.equal(P.ruleTarget("x"), null);
  assert.ok(P.sameRules([{ id: "d", when: {}, set: { boost: { mode: "follow", offsetW: 5 } } }], [{ id: "d", when: {}, set: { boost: { mode: "follow", offsetW: 9 } } }]));
});

test("conflict cards and records (D3, D4, D5, D8, D11)", () => {
  assert.deepEqual(P.offCard("thermald"), { id: "power-off", steps: [0] });
  assert.deepEqual(P.offCard("tuned-ppd"), { id: "power-off", steps: [2] });
  assert.deepEqual(P.offCard("som-remote:local.oxp3.Tdp"), { id: "power-off", steps: [7] });
  assert.deepEqual(P.offCard("decky-powertools"), { id: "decky-leftovers", steps: [0, 3] });
  assert.deepEqual(P.offCard("hhd"), { id: "hhd-tdp" });
  assert.deepEqual(P.onCard("intel_lpmd"), { id: "power-on", steps: [3] });
  assert.deepEqual(P.offAllSteps(["power-profiles-daemon", "thermald", "tuned", "tuned-ppd"]), [0, 1, 2]);
  assert.ok(P.ignorable("hhd") && P.ignorable("som-remote:x") && !P.ignorable("thermald"));
  const rec = P.recordTurnedOff([{ id: "thermald", active: true }], [{ id: "thermald", active: false }], {}, 5);
  assert.deepEqual(rec, { thermald: { at: 5 } });
  assert.equal(P.conflictText({ id: "power-profiles-daemon", name: "x" }).name, "Power Profiles");
});

test("power tips: headroom, raise, plug, cpu (sampler.py _advise)", () => {
  const b = P.newBucket();
  for (let i = 0; i < 70; i++) P.count(b, 20, 5, 9, 40, [], false);
  const ctx = { tdpW: 20, tdpMin: 5, tdpMax: 35, tdpMaxAc: null, ac: false };
  const a = P.advise(b, ctx);
  assert.equal(a.kind, "headroom");
  assert.equal(a.suggestW, 12);
  const hot = P.newBucket();
  for (let i = 0; i < 70; i++) P.count(hot, 20, 5, 20, 98, ["pl1"], false);
  assert.equal(P.advise(hot, ctx).kind, "raise");
  assert.equal(P.advise(hot, { ...ctx, tdpW: 35, tdpMaxAc: 40 }).kind, "plug");
  assert.equal(P.advise(hot, { ...ctx, tdpW: 35, ac: true }).kind, "cpu");
  const short = P.newBucket();
  P.count(short, 20, 5, 9, 40, [], false);
  assert.equal(P.advise(short, ctx), null, "nothing before 5 minutes");
});

test("XeSS env file, unit, driver status (xess.py)", () => {
  const env = P.envValues('# c\nVK_DRIVER_FILES="/p/x/run/intel_icd.json:/usr/share/vulkan/icd.d/intel.json"\nANV_CM_HELPER=/p/x/tools/cm-compile.sh\n');
  assert.deepEqual(P.packagesFromEnv(env), ["/p/x"]);
  assert.equal(P.packageFromUnit('ExecStart=/usr/bin/bash "/p/y/tools/session-check.sh"'), "/p/y");
  const ok = P.parseStatus("ok 2026-11-01 09:26:46 /p/lib/mesa-26.3.0-rc3/libvulkan_intel.so Mesa 26.3.0-rc3 (note: vulkaninfo not installed) (the previous driver failed: crash; switched to Mesa 26.1.2)");
  assert.equal(ok.state, "ok");
  assert.equal(ok.driver, "26.3.0-rc3");
  assert.equal(ok.switchedTo, "26.1.2");
  assert.ok(ok.notes.includes("vulkaninfo not installed"));
  const failed = P.parseStatus("FAILED 2026-11-02 08:00:01 /p/lib/mesa-26.3.0-rc2/libvulkan_intel.so: device lost");
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "device lost");
  assert.equal(P.parseStatus("").state, "unknown");
});

test("XeSS tags and release rows (G2, G20)", () => {
  assert.ok(P.tagNewer("20261104", "20261031"));
  assert.ok(P.tagNewer("20261104-2", "20261104"));
  assert.ok(P.tagNewer("20261020", "v1.9"));
  assert.ok(!P.tagNewer("20261031", "20261104"));
  assert.equal(P.packageVersion("/a/xess-xmx-linux-20261031"), "20261031");
  assert.equal(P.packageVersion("/a/other"), null);
  assert.ok(P.fsrSupported("20261104") && !P.fsrSupported("20261031"));
  assert.deepEqual(P.releaseRows("20261031", true).map((r) => r.id), ["older", "driverstore"]);
  assert.equal(P.driverPrefix("26.3.0-rc2"), "26.3");
});

test("XeSS command lines quote paths and refuse unsafe ones (G7–G11, G17)", () => {
  assert.match(P.installLines("20261104"), /releases\/download\/20261104\/xess-xmx-linux-20261104\.zip/);
  assert.equal(P.installLines("2026; rm -rf /"), null);
  assert.equal(P.repairLine("/home/d/xess-xmx-linux-1"), "cd '/home/d/xess-xmx-linux-1' && bash install.sh");
  assert.equal(P.repairLine("/home/d/it's"), null);
  assert.equal(P.uninstallLine("relative/path"), null);
  assert.match(P.updateLines("/h/xess-xmx-linux-20261031", "20261104"), /bash '\/h\/xess-xmx-linux-20261031'\/uninstall\.sh/);
  assert.equal(P.switchDriverLine("/h/p", "26.3.0-rc3"), "cd '/h/p' && bash tools/switch-driver.sh 26.3");
  assert.equal(P.removeFolderLine("/h/xess-xmx-linux-20261020"), "rm -rf '/h/xess-xmx-linux-20261020'");
  assert.equal(P.removeFolderLine("/h/Documents"), null);
});

test("game advice, suggestions, checks and the XeSS-FG refusal (H14, H17, H18, games.py)", () => {
  const facts = { appid: 1, installed: true, dlls: [{ name: "libxess.dll", path: "a/libxess.dll", version: "1.3.0.0", kind: "xess" }, { name: "libxell.dll", path: "a/libxell.dll", version: "1.2.1.13", kind: "xess" }], leftovers: [], truncated: false, hasPrefix: true, lastRun: null, driverStoreCapital: true, compatTool: { name: "proton-cachyos-slr", perGame: true }, systemProton: true, antiCheat: null };
  const tips = P.advice(facts, true, true);
  assert.ok(tips.some((t) => t.includes("older than 2.0.2.68")));
  assert.ok(tips.some((t) => t.includes("system Proton")));
  assert.deepEqual(P.suggest(facts, true, true), [], "no hook on a system Proton");
  assert.deepEqual(P.suggest({ ...facts, systemProton: false }, true, true).map((s) => `${s.key}=${s.value}`), ["XESS=latest"]);
  assert.equal(P.checks(facts)[0].id, "driverstore");
  const x = P.xefgCheck("XeFG[3] Latency reduction is not enabled.\nxefgSwapChainSetEnabled(1) -> -15\n", 1);
  assert.equal(x.refused, true);
  assert.equal(x.reason, "latency_reduction_off");
  assert.equal(x.lines.length, 2);
  assert.equal(P.xefgCheck("xefgSwapChainSetEnabled(1) -> -15\nxefgSwapChainSetEnabled(1) -> 0\n", 1).refused, false, "a later success means it is on");
  assert.ok(P.isSystemProton("proton-cachyos") && !P.isSystemProton("GE-Proton11-11"));
  assert.equal(P.antiCheatOf("EasyAntiCheat_EOS.sys"), "EasyAntiCheat");
  assert.equal(P.antiCheatOf("BEClient_x64.dll"), "BattlEye");
  assert.equal(P.antiCheatOf("game.exe"), null);
});

test("the copy line keeps the user's words (H10, launchopts.setManaged)", () => {
  assert.equal(P.copyLine("gamemoderun %command% --launcher-skip", { vars: { XESS: "latest" } }), "XESS=latest gamemoderun %command% --launcher-skip");
  assert.equal(P.copyLine("XESS=dp4a %command%", { vars: { XESS: null } }), "", "a bare %command% is the same as empty");
  assert.equal(P.copyLine("%command% -a | tee log", { args: { add: ["-dx12"] } }), "%command% -a -dx12 | tee log");
  assert.equal(P.copyLine("-skipintro", { vars: { XESS_FG: "3" } }), "XESS_FG=3 %command% -skipintro");
});

test("one-run XeSS logging (src/xesslog.ts exitStep)", () => {
  assert.deepEqual(P.exitStep(true, undefined, null, 1000), { do: "record", rec: { onAt: 1000, keep: false, offAt: null, at: 1000 } });
  const rec = { onAt: 1000, keep: false, offAt: null, at: 1000 };
  assert.equal(P.exitStep(true, rec, 900, 2000).do, "nothing", "an old log is from before");
  assert.equal(P.exitStep(true, rec, 1500, 2000).do, "off");
  assert.equal(P.exitStep(true, { ...rec, keep: true }, 1500, 2000).do, "nothing");
  assert.equal(P.exitStep(false, { ...rec, offAt: 2000 }, null, 2000 + 60_000).do, "nothing", "the note stays for the next run");
  assert.deepEqual(P.exitStep(false, { ...rec, offAt: 2000 }, null, 2000 + 200_000), { do: "record", rec: null });
});

test("automatic setup: classes and plans (I3, autosetup.py _build_plan)", () => {
  const base = { appid: 292030, installed: true, dlls: [{ name: "libxess.dll", path: "x", version: "1.3.0.0", kind: "xess" }], leftovers: [], truncated: false, hasPrefix: true, lastRun: null, driverStoreCapital: false, compatTool: null, systemProton: false, antiCheat: null };
  assert.equal(P.classify(570, "Dota 2", base).cls, "skipped");
  assert.equal(P.classify(1, "X", { ...base, antiCheat: "BattlEye" }).cls, "skipped");
  assert.equal(P.classify(292030, "W3", base).cls, "known");
  const lo = { text: "XESS_FG=3 %command%", managed: { vars: { XESS_FG: "3" }, args: [] }, warnings: [] };
  const p = P.plan(292030, "W3", undefined, base, lo, true, true);
  assert.deepEqual(p.set, { XESS: "latest" });
  assert.deepEqual(p.args, ["-dx12"], "frame generation is set, so DirectX 12 for The Witcher 3");
  const mh = P.plan(2246340, "MH", undefined, { ...base, appid: 2246340, dlls: [] }, { text: "XESS_FG=3 %command%", managed: { vars: { XESS_FG: "3" }, args: [] }, warnings: [] }, true, true);
  assert.deepEqual(mh.remove, ["XESS_FG"], "a key known to crash MH Wilds is taken out");
  assert.deepEqual(P.handSet(lo, undefined), ["XESS_FG=3"]);
  const blocked = P.plan(292030, "W3", { changes: [{ id: "c", state: "rolled_back", kept: false, set: { XESS: "latest" }, dropped: {}, args: [] }] }, base, lo, true, true);
  assert.deepEqual(blocked.set, {}, "a rolled-back change is not made again by itself");
});

test("oxp3-tool state, reboot pending, stale helpers (F4, F12, F13)", () => {
  const st = P.parseState(JSON.stringify({ schema: 1, fixes: { gyro: { applied_at: "x", tool_version: "0.4.2", kargs: [] }, "nvme-resume": { applied_at: "x", tool_version: "0.4.4", kargs: ["nvme.noacpi=1"] }, "xe-dsb-off": { applied_at: null, tool_version: "0.4.4", kargs_pending_add: ["xe.enable_dsb=0"] }, "volume-keys": { reverted: true } } }));
  assert.equal(st.error, null);
  assert.deepEqual(P.rebootPending(st.fixes, "root=x nvme.noacpi=1").sort(), ["volume-keys", "xe-dsb-off"]);
  assert.deepEqual(P.rebootPending(st.fixes, "root=x").sort(), ["nvme-resume", "volume-keys", "xe-dsb-off"]);
  assert.deepEqual(P.staleFixes({ fixes: st.fixes, toolVersion: "0.4.4" }), ["gyro"]);
  assert.equal(P.parseState("{bad").error.includes("damaged"), true);
  assert.equal(P.parseState(JSON.stringify({ schema: 2, fixes: {} })).error !== null, true);
  assert.ok(P.versionNewer("0.4.10", "0.4.4"));
});

test("oxp3-tool lines only from the catalog (F7, F8)", () => {
  assert.equal(P.applyLine(catalog, ["oled-profile"], { minRefresh: 40 }), "sudo oxp3-tool apply oled-profile --min-refresh 40");
  assert.equal(P.applyLine(catalog, ["oled-profile"], { minRefresh: 20 }), null);
  assert.equal(P.applyLine(catalog, ["nvme-resume"], { anySsd: true }), "sudo oxp3-tool apply nvme-resume --any-ssd");
  assert.equal(P.applyLine(catalog, ["rm -rf"]), null);
  assert.equal(P.revertLine(catalog, "gyro"), "sudo oxp3-tool revert gyro");
  const b = P.savedButtons(catalog, { actions: { home: "fps-limit", onex: "nonsense" }, fps_limit: 60 });
  assert.equal(b.actions.onex, "quick-access");
  assert.equal(P.buttonsLine(catalog, { ...b, xboxHelper: true, noRestart: true }), "sudo oxp3-tool apply buttons xbox-key --onex-key quick-access --keyboard-key keyboard --home fps-limit --xbox-key guide --fps-limit 60 --no-restart");
});

test("update parsing (F3, G12)", () => {
  assert.equal(P.parseToolVersion('"""x"""\n__version__ = "0.4.5"\n'), "0.4.5");
  assert.equal(P.parseToolVersion("nothing"), null);
  assert.equal(P.tagFromLocation("https://github.com/HHHHanasak1/xess-xmx-linux/releases/tag/20261104"), "20261104");
  assert.equal(P.tagFromLocation("https://github.com/x/releases/tag/a;b"), null);
});

// ---- review findings -------------------------------------------------------------------------------

/** SPEC §5.3's shared launch-option cases (schemas/fixtures/launch-options), the "oxp3deck" result where the original's differs. */
const launchCases = JSON.parse(readFileSync(new URL("../.bathysphere/schemas/fixtures/launch-options/cases.json", import.meta.url), "utf8")).cases;

test("the copy line re-quotes game arguments when it puts %command% in front of them (§5.3 set)", () => {
  // without %command% Steam passes these words to the game as they are; with it, a shell reads them
  assert.equal(P.copyLine("-novid $(touch /tmp/x) ;reboot", { vars: { XESS: "latest" } }), "XESS=latest %command% -novid '$(touch' '/tmp/x)' ';reboot'");
  assert.equal(P.copyLine("-say it's `id`", { args: { add: ["-dx12"] } }), "%command% -say 'it'\\''s' '`id`' -dx12");
  assert.equal(P.copyLine("'%com'mand% -x", { vars: { XESS: "latest" } }), "", "an argument that reads as %command%: no safe line");
  const cases = launchCases.filter((c) => c.op === "set" && !c.text.includes("%command%") && c.vars && Object.values(c.vars).some((v) => v !== null));
  assert.ok(cases.length >= 10, "the requote cases are there");
  for (const c of cases) {
    // where hostd refuses the text (expect.error) there is no line to offer
    const want = c.oxp3deck ?? c.expect.text ?? "";
    assert.equal(P.copyLine(c.text, { vars: c.vars }), want, c.name);
  }
});

test("the last run: the driver's canary means fast mode; a trace alone does not (GameControls.tsx lastRunLine)", () => {
  const run = (over) => ({ trace: false, fallback: null, compileFailed: false, canary: false, xellUnsupported: null, xellBuiltin: null, fgFullscreen: null, xefg: null, loggedAt: 1, logAt: null, ...over });
  assert.deepEqual(P.lastRunRow(run({ canary: true })), { label: "Last run: fast mode used", line: "XeSS ran on the XMX cores.", bad: false });
  assert.equal(P.lastRunRow(run({ trace: true })).label, "Last run: no sign of fast mode");
  assert.match(P.lastRunRow(run({ trace: true })).line, /driver saw no XeSS self-test/);
  assert.equal(P.lastRunRow(run({ trace: true, canary: true, fallback: "self-test failed" })).label, "Last run: slower mode");
  assert.equal(P.lastRunRow(run({ canary: true, compileFailed: true })).label, "Last run: slower mode");
  assert.equal(P.lastRunRow(run({ loggedAt: null })), null);
});

test("system Protons are the distribution's packages, not user builds of the same Proton (steamlib.py is_system_tool)", () => {
  for (const n of ["proton-cachyos", "proton-cachyos-slr", "proton-cachyos-native", "Proton-CachyOS"]) assert.ok(P.isSystemProton(n), n);
  for (const n of ["proton-cachyos-10.0-20250807-slr-x86_64_v3", "proton-cachyos-10.0-20251007-slr", "GE-Proton11-11", "proton_experimental", undefined]) assert.ok(!P.isSystemProton(n), String(n));
});

test("automatic setup: an edit in Steam of what a change did counts as taking over (autolaunch.ts touched)", () => {
  const change = { id: "c", at: 1, label: "x", why: "", set: { XESS: "latest" }, dropped: { XESS_FG: "3" }, args: ["-dx12"], state: "live", tested: false, accepted: false, kept: false };
  const g = { changes: [change] };
  const lo = (vars, args) => ({ text: "", managed: { vars, args }, warnings: [] });
  assert.equal(P.touched(lo({ XESS: "latest" }, ["-dx12"]), g), false);
  assert.equal(P.touched(lo({ XESS: "latest" }, []), g), true, "the argument it added is gone");
  assert.equal(P.touched(lo({ XESS: "latest", XESS_FG: "3" }, ["-dx12"]), g), true, "a key it took out is back");
  assert.equal(P.touched(lo({ XESS: "dp4a" }, ["-dx12"]), g), true);
  assert.deepEqual(P.handSet(lo({ XESS: "latest", MESA: "26.3" }, ["-dx12"]), g), ["MESA=26.3"], "keys no change accounts for");
});

test("text for code rows and dialogs: invisible characters, log tails, dialog titles (§5.3, §6.2)", () => {
  assert.ok(P.copySafe("a\tb\nc"));
  for (const bad of ["a​b", "x\r", "x\u0085", "﻿x", "a b"]) assert.ok(!P.copySafe(bad), JSON.stringify(bad));
  assert.equal(P.logTail("one\r\ntwo​\n\tthree\u0007\n", 100), "one\ntwo\n\tthree\n", "newlines and tabs stay, other controls go");
  const tail = P.logTail("x".repeat(5000) + "\nlast line", 2048);
  assert.ok(new TextEncoder().encode(tail).length <= 2048 && tail.endsWith("last line") && tail.startsWith("…"));
  const t = P.dialogTitle("Delete the profile of ", "The Legend of Heroes: Trails of Cold Steel IV - The End of Saga", "?");
  assert.ok([...t].length <= 80 && t.startsWith("Delete the profile of The Legend") && t.endsWith("?"), t);
  assert.equal(P.dialogTitle("Use frame generation in ", "Dota 2", "?"), "Use frame generation in Dota 2?");
});

test("command lines refuse invisible characters; the boot marker only names oxp3-tool's commands", () => {
  assert.equal(P.quotePath("/home/deck/xess-xmx-linux-20261104​"), null);
  assert.equal(P.quotePath("/home/deck/a\u0085b"), null);
  assert.equal(P.quotePath("/home/jörg/xess-xmx-linux-20261104"), "'/home/jörg/xess-xmx-linux-20261104'", "letters of any script are fine");
  assert.equal(P.uninstallLine("/home/deck/x "), null);
  assert.equal(P.markerCommand("limine-update\n"), "limine-update");
  assert.equal(P.markerCommand("grub-mkconfig -o /boot/grub/grub.cfg\n"), "grub-mkconfig -o /boot/grub/grub.cfg");
  assert.equal(P.markerCommand("limine-update\u0085\n"), null);
  assert.equal(P.markerCommand("rm -rf / --no-preserve-root\n"), null);
});

test("a broken redirect falls back to the API instead of throwing (updates)", () => {
  assert.equal(P.tagFromLocation("https://github.com/HHHHanasak1/xess-xmx-linux/releases/tag/%E0%A4%A"), null);
});

test("the manifest asks only for what the plugin uses (§3.2 consent fields, §5.4 network)", () => {
  const m = JSON.parse(readFileSync(new URL("../dist/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(m.envRead, ["VK_DRIVER_FILES"], "ANV_CM_HELPER comes from the env file, not the session");
  assert.deepEqual(m.userUnits, ["xess-xmx-check.service", "xess-xmx-shim.path"]);
  assert.deepEqual(m.network.map((n) => n.host), ["github.com", "api.github.com"], "no host that serves user content");
  assert.ok(m.contributes.instructions.some((i) => i.id === "xess-tools-bazzite"));
});
