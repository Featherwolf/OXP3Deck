// Tests for src/opti.ts (OptiScaler's launch-option plan, choices, checklist, texts), the launchopts list helpers,
// and the OptiScaler wiring of copyopts, autolaunch and the components. Run from the repository root:
// node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const o = await import("../../src/opti.ts");
const { hasListEntry, setListEntry, setManaged, varValue } = await import("../../src/launchopts.ts");
const { copyLine } = await import("../../src/copyopts.ts");
const { plan: autoPlan } = await import("../../src/autolaunch.ts");
const { EFFECTS } = await import("../../src/effects.ts");
const { MAX_LINE } = await import("../../src/text.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

const REMOVE = ["XESS", "FSR", "FSR_FG", "force_vk_vendor"];
const P2 = { set: { XESS_FG: "2" }, remove: REMOVE, dll_override: "dxgi", dxvk_config: null, args: ["-dx12"] };
const P4 = { set: { XESS_FG: "4" }, remove: REMOVE, dll_override: "dxgi", dxvk_config: "dxgi.customVendorId = 8086", args: ["-dx12"] };
const P0 = { set: {}, remove: [...REMOVE, "XESS_FG"], dll_override: "dxgi", dxvk_config: null, args: ["-dx12"] };

// ---- launchopts: list variables -----------------------------------------------------------------------------------

test("setListEntry: adds one entry, keeps the user's, takes out only ours", () => {
  assert.equal(setListEntry("", "WINEDLLOVERRIDES", "dxgi=n,b", true), "WINEDLLOVERRIDES=dxgi=n,b %command%");
  assert.equal(setListEntry("%command% -x", "WINEDLLOVERRIDES", "dxgi=n,b", true), "WINEDLLOVERRIDES=dxgi=n,b %command% -x");
  const user = "WINEDLLOVERRIDES=\"d3d11=n\" gamemoderun %command%";
  const on = setListEntry(user, "WINEDLLOVERRIDES", "dxgi=n,b", true);
  assert.equal(on, "WINEDLLOVERRIDES='d3d11=n;dxgi=n,b' gamemoderun %command%");
  assert.equal(setListEntry(on, "WINEDLLOVERRIDES", "dxgi=n,b", true), on, "added once");
  assert.equal(setListEntry(on, "WINEDLLOVERRIDES", "dxgi=n,b", false), "WINEDLLOVERRIDES=d3d11=n gamemoderun %command%");
  // a variable holding only ours goes as a whole; text that is then only %command% stays as setManaged leaves it
  assert.equal(setListEntry("WINEDLLOVERRIDES=dxgi=n,b %command% -dx12", "WINEDLLOVERRIDES", "dxgi=n,b", false), "%command% -dx12");
  assert.equal(setListEntry("MESA=26.1 %command%", "WINEDLLOVERRIDES", "dxgi=n,b", false), "MESA=26.1 %command%", "absent: unchanged");
  // DXVK_CONFIG: spaces inside an entry, compared without them; quoted as one literal word
  const d = setListEntry("DXVK_CONFIG=\"dxvk.enableAsync = True\" %command%", "DXVK_CONFIG", "dxgi.customVendorId = 8086", true);
  assert.equal(d, "DXVK_CONFIG='dxvk.enableAsync = True;dxgi.customVendorId = 8086' %command%");
  assert.equal(varValue(d, "DXVK_CONFIG"), "dxvk.enableAsync = True;dxgi.customVendorId = 8086");
  assert.ok(hasListEntry("DXVK_CONFIG=dxgi.customVendorId=8086 %command%", "DXVK_CONFIG", "dxgi.customVendorId = 8086"));
  assert.equal(setListEntry("DXVK_CONFIG='a=1' %command%", "DXVK_CONFIG", "dxgi.customVendorId = 8086", false), "DXVK_CONFIG='a=1' %command%");
  // a typo is left alone
  assert.equal(setListEntry("%command -x", "WINEDLLOVERRIDES", "dxgi=n,b", true), "%command -x");
});

test("setManaged is unchanged by the generic setter", () => {
  assert.equal(setManaged("gamemoderun %command%", { XESS: "latest" }), "XESS=latest gamemoderun %command%");
  assert.equal(setManaged("XESS=latest %command%", { XESS: null }), "");
});

// ---- applyPlan / undoPlan / changePlan ----------------------------------------------------------------------------

test("applyPlan: drops the replaced XeSS keys, sets the multiplier, adds the override and -dx12", () => {
  const a = o.applyPlan("XESS=latest force_vk_vendor=-1 MESA=26.1 %command% --launcher-skip", P2);
  assert.equal(a.text, "MESA=26.1 XESS_FG=2 WINEDLLOVERRIDES=dxgi=n,b %command% --launcher-skip -dx12");
  assert.deepEqual(a.dropped, { XESS: "latest", force_vk_vendor: "-1" });
  assert.deepEqual(a.args, ["-dx12"]);
  assert.deepEqual(a.lists, ["WINEDLLOVERRIDES"]);
  // MESA and XESS_LOG are kept
  assert.match(o.applyPlan("XESS_LOG=1 %command%", P2).text, /^XESS_LOG=1 /);
  // twice: nothing more
  assert.equal(o.applyPlan(a.text, P2).text, a.text);
  assert.deepEqual(o.applyPlan(a.text, P2).dropped, {});
  // empty and argument-only text
  assert.equal(o.applyPlan("", P2).text, "XESS_FG=2 WINEDLLOVERRIDES=dxgi=n,b %command% -dx12");
  assert.equal(o.applyPlan("--launcher-skip", P2).text, "XESS_FG=2 WINEDLLOVERRIDES=dxgi=n,b %command% --launcher-skip -dx12");
  // a typo: unchanged
  assert.equal(o.applyPlan("XESS=latest %command -dx12", P2).text, "XESS=latest %command -dx12");
  // 3x/4x: the DXVK vendor id
  assert.equal(o.applyPlan("", P4).text, "XESS_FG=4 WINEDLLOVERRIDES=dxgi=n,b DXVK_CONFIG='dxgi.customVendorId = 8086' %command% -dx12");
});

test("applyPlan: a user's XESS_FG replaced is kept to put back; -dx12 already there is not ours", () => {
  const a = o.applyPlan("WINEDLLOVERRIDES=\"d3d11=n\" XESS_FG=3 gamemoderun %command% -dx12", P2);
  assert.equal(a.text, "WINEDLLOVERRIDES='d3d11=n;dxgi=n,b' XESS_FG=2 gamemoderun %command% -dx12");
  assert.deepEqual(a.dropped, { XESS_FG: "3" });
  assert.deepEqual(a.args, []);
  const e = o.entryOf(P2, a, 1);
  // a change by hand since: the surgical undo, the user's own entries and argument stay
  const edited = `${a.text} --launcher-skip`;
  assert.equal(o.undoEntry(edited, e), "WINEDLLOVERRIDES=d3d11=n XESS_FG=3 gamemoderun %command% -dx12 --launcher-skip");
});

test("Remove gives back the exact launch options when nothing changed since", () => {
  for (const before of ["", "XESS=latest force_vk_vendor=-1 MESA=26.1 %command% --launcher-skip",
    "WINEDLLOVERRIDES=\"d3d11=n\" XESS_FG=3 gamemoderun %command% -dx12", "--launcher-skip"]) {
    const s = o.syncPlan(before, undefined, P2, 1);
    assert.equal(s.entry.before, before);
    assert.equal(s.entry.after, s.text);
    const c = o.syncPlan(s.text, s.entry, P4, 2);       // a choice change keeps the exact restore
    assert.equal(c.entry.before, before);
    const back = o.syncPlan(c.text, c.entry, null, 3);
    assert.equal(back.text, before, JSON.stringify(before));
    assert.equal(back.entry, null);
  }
});

test("undoPlan: only what is still as written; dropped values only where the key is absent", () => {
  const a = o.applyPlan("XESS=latest MESA=26.1 %command%", P2);
  const e = o.entryOf(P2, a, 1);
  // the user changed XESS_FG and set XESS again by hand: both stay
  const hand = a.text.replace("XESS_FG=2", "XESS_FG=3").replace("MESA=26.1", "MESA=26.1 XESS=dp4a");
  const u = o.undoPlan(hand, P2, e);
  assert.match(u, /XESS_FG=3/);
  assert.match(u, /XESS=dp4a/);
  assert.doesNotMatch(u, /XESS=latest/);
  assert.doesNotMatch(u, /WINEDLLOVERRIDES|-dx12/);
  // nothing by hand: the dropped value is back, ours are gone
  assert.equal(o.undoPlan(a.text, P2, e), "MESA=26.1 XESS=latest %command%");
});

test("changePlan: only the difference; the user's first value stays recorded", () => {
  const a = o.applyPlan("XESS_FG=3 %command% --launcher-skip", P2);
  const e = o.entryOf(P2, a, 1);
  const c4 = o.changePlan(a.text, e, P4, 2);
  assert.equal(c4.text, "WINEDLLOVERRIDES=dxgi=n,b XESS_FG=4 DXVK_CONFIG='dxgi.customVendorId = 8086' %command% --launcher-skip -dx12");
  assert.deepEqual(c4.entry.dropped, { XESS_FG: "3" });
  assert.deepEqual(c4.entry.lists.sort(), ["DXVK_CONFIG", "WINEDLLOVERRIDES"]);
  assert.deepEqual(c4.entry.args, ["-dx12"]);
  const c0 = o.changePlan(c4.text, c4.entry, P0, 3);
  assert.equal(c0.text, "WINEDLLOVERRIDES=dxgi=n,b %command% --launcher-skip -dx12");
  assert.deepEqual(c0.entry.dropped, { XESS_FG: "3" }, "XESS_FG stays taken out with frame generation off");
  assert.deepEqual(c0.entry.lists, ["WINEDLLOVERRIDES"]);
  // a plan without frame generation and without the override: XESS_FG=3 is back
  const none = { set: {}, remove: REMOVE, dll_override: null, dxvk_config: null, args: [] };
  assert.equal(o.changePlan(c4.text, c4.entry, none, 4).text, "XESS_FG=3 %command% --launcher-skip");
});

test("syncPlan: pending entries (nothing applied yet) apply on the next sync", () => {
  const pend = o.pendingEntry(undefined, P2, 5);
  assert.equal(pend.pending, true);
  assert.equal(pend.plan, null);
  const s = o.syncPlan("XESS=latest %command%", pend, pend.want, 6);
  assert.equal(s.text, "XESS_FG=2 WINEDLLOVERRIDES=dxgi=n,b %command% -dx12");
  assert.equal(s.entry.pending, false);
  // removed while nothing was applied: no entry, text unchanged
  assert.deepEqual(o.syncPlan("%command%", o.pendingEntry(undefined, null, 1), null, 2), { text: "%command%", entry: null });
});

test("readLog / fitLog: well-formed entries only, newest 20, under 4 KB", () => {
  const good = o.entryOf(P2, o.applyPlan("", P2), 10, "");
  const log = o.readLog({ "292030": good, bad: good, "1": { plan: { set: { EVIL: "x" }, remove: ["rm -rf"], args: ["$(x)"] }, at: 1 },
    "2": "nope", "3": o.pendingEntry(undefined, null, 4) });
  assert.deepEqual(Object.keys(log).sort(), ["1", "292030", "3"]);
  assert.deepEqual(log["1"].plan, { set: {}, remove: [], dll_override: null, dxvk_config: null, args: [] });
  assert.equal(log["292030"].before, "");
  assert.equal(log["3"].pending, true);
  assert.deepEqual(o.readLog(JSON.parse(JSON.stringify(log))), log, "a round trip through JSON");
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(1000 + i), { ...good, at: i }]));
  const fit = o.fitLog(many);
  assert.ok(Object.keys(fit).length <= o.LOG_MAX);
  assert.ok(JSON.stringify(fit).length <= 3800);
  assert.ok(fit["1039"], "the newest kept");
  assert.deepEqual(o.readLog(null), {});
});

// ---- choices, checklist, texts ------------------------------------------------------------------------------------

test("checklist: the numbered steps for each game setting", () => {
  // The Witcher 3 (the tested setup): its own XeSS frame generation is the default input (Streamline 1: no dlssg)
  const d = o.checklist(o.DEFAULT_CHOICES.fg_input, o.DEFAULT_CHOICES.fg);
  assert.equal(o.DEFAULT_CHOICES.fg_input, "xefg");
  assert.equal(d.length, 6);
  assert.match(d[0], /^1\. Start the game/);
  assert.match(d[1], /Borderless/);
  assert.match(d[2], /Upscaling: XeSS/);
  assert.match(d[3], /XeSS Frame Generation on/);
  assert.match(d[4], /again, once/);
  assert.match(d[5], /OptiScaler's menu .*XeFG/);
  assert.match(o.checklist("xefg", 3).join(" "), /XeSS Frame Generation on/);
  // OptiFG: XeSS or DLSS upscaling, the game's frame generation off, gamma and brightness at their defaults
  const of = o.checklist("upscaler", 2).join(" ");
  assert.match(of, /Upscaling: XeSS or DLSS/);
  assert.match(of, /off in the game; OptiScaler makes the frames/);
  assert.match(of, /Gamma and brightness: leave them at their defaults/);
  assert.doesNotMatch(o.checklist("xefg", 2).join(" "), /Gamma/);
  assert.doesNotMatch(o.checklist("xefg", 0).join(" "), /Frame Generation/);
  assert.equal(o.checklistLine("xefg", 4), "Pick XeSS and XeSS frame generation, then restart the game.");
  assert.equal(o.checklistLine("upscaler", 2), "Pick XeSS or DLSS, game FG off, default gamma/brightness, then restart.");
  assert.equal(o.checklistLine("upscaler", 0), "Pick XeSS or DLSS in the game, then restart it once.");
  assert.match(o.CHECKLIST_HELP.join(" "), /greyed out: the game uses Streamline 1/);
  assert.match(o.CHECKLIST_HELP.join(" "), /gamma and brightness at their defaults/);
  // dlssg where OptiScaler's wiki documents it (a known game such as Cyberpunk 2077)
  const known = { kind: "known", api: "dx12", pick: "XeSS" };
  const k = o.checklist("dlssg", 2, known);
  assert.match(k[2], /Upscaling: XeSS/);
  assert.match(k[3], /DLSS Frame Generation on/);
  assert.equal(o.checklistLine("dlssg", 2, known), "Pick XeSS and DLSS frame generation, then restart the game.");
  assert.doesNotMatch(o.checklist("dlssg", 0, known).join(" "), /Frame Generation/);
  assert.equal(o.optiFgIni({ OptiFG_HUDLimit: "1", OptiFG_ResourceBlocking: "true" }), "OptiFG HUDFix=true HUDLimit=1 ResourceBlocking=true");
  assert.equal(o.optiFgIni(undefined), "OptiFG HUDFix=true");
});

test("labels, statusLine and readChoices", () => {
  assert.deepEqual(o.choiceLabels({ upscaler: "fsr31", fg: 3, fg_input: "xefg" }), { upscaler: "FSR 3.1", fg: "XeFG 3x", input: "XeSS frame generation" });
  const info = { state: "installed", update: false, choices: { upscaler: "xess", fg: 2, fg_input: "xefg" } };
  assert.equal(o.statusLine(info), "XeSS · frame generation 2x");
  assert.equal(o.statusLine({ ...info, update: true }), "Update available");
  assert.equal(o.statusLine({ ...info, state: "none" }), "Not installed");
  assert.equal(o.statusLine({ ...info, state: "other" }), "Another OptiScaler is installed");
  assert.equal(o.statusLine({ ...info, state: "partial" }), "Partly removed: open Details");
  assert.equal(o.readChoices({ upscaler: "xess", fg: 5, fg_input: "dlssg" }), null);
  assert.deepEqual(o.readChoices(o.DEFAULT_CHOICES), { upscaler: "xess", fg: 2, fg_input: "xefg" });
});

test("one-liners are short and name no variables; dialogs say when they take effect", () => {
  const VAR = /\b(XESS|XESS_FG|FSR|FSR_FG|WINEDLLOVERRIDES|DXVK_CONFIG|force_vk_vendor)\b|=/;
  const lines = [
    ...["dlssg", "xefg", "upscaler"].flatMap((i) => [0, 2, 3, 4].map((f) => o.checklistLine(i, f))),
    ...["none", "installed", "partial", "other"].map((state) => o.statusLine({ state, update: false, choices: o.DEFAULT_CHOICES })),
    ...o.optiWarnings({ compat_tool_shimmed: false, compat_tool: "proton-cachyos", prefix_checks: { hides_wine: true } }, false).map((w) => w.line),
  ];
  assert.doesNotMatch(o.readyToast("The Witcher 3", "xefg", 2), VAR);
  for (const l of lines) {
    assert.ok(l.length <= MAX_LINE, l);
    assert.doesNotMatch(l, VAR, l);
  }
  const info = { cached: false, download_mb: 69, folder: "/games/The Witcher 3/bin/x64_dx12", launch: P2 };
  const ci = o.confirmInstall(info, "The Witcher 3", o.DEFAULT_CHOICES);
  assert.equal(ci.title, "Install OptiScaler?");
  assert.equal(ci.effect, "game");
  assert.match(ci.text[0], /Downloads OptiScaler \(about 69 MB\) and puts it in The Witcher 3's folder\. Remove puts everything back\./);
  assert.ok(ci.lines.some((l) => l.includes("WINEDLLOVERRIDES: dxgi=n,b")));
  assert.match(o.confirmInstall({ ...info, cached: true }, "W", o.DEFAULT_CHOICES).text[0], /^Puts OptiScaler in/);
  assert.ok(!ci.text.some((t) => /backup/.test(t)), "no backup promise");
  assert.ok(ci.text.some((t) => t.includes("Install stops if the folder already has a dxgi.dll or another OptiScaler")));
  const e = o.entryOf(P2, o.applyPlan("XESS=latest %command%", P2), 1);
  const cr = o.confirmRemove(info, "The Witcher 3", e);
  assert.equal(cr.effect, "game");
  assert.ok(cr.destructive);
  assert.ok(cr.lines.includes("Puts back: XESS=latest"));
  assert.equal(o.optiWarnings({ compat_tool_shimmed: true, compat_tool: "GE-Proton11-11" }, true).length, 0);
  // the backend's lines when it sends them, with the frontend's labels and Details
  const rows = o.warningRows({ warnings: ["OptiScaler's XeSS will run in the slower mode.", "Something new."] }, null, true);
  assert.deepEqual(rows.map((r) => r.label), ["XeSS fast mode missing", "OptiScaler"]);
  assert.equal(o.warningRows({ warnings: [] }, { compat_tool_shimmed: false }, false).length, 0);
  assert.equal(o.warningRows({}, { compat_tool_shimmed: false }, true).length, 1);
  // the install dialog lists the defaults' plan only while the choices are the defaults
  const fresh = { cached: false, download_mb: 69, defaults: o.DEFAULT_CHOICES, launch: null, launch_new: P2 };
  assert.ok(o.confirmInstall(fresh, "W", o.DEFAULT_CHOICES).lines.some((l) => l.includes("XESS_FG=2")));
  assert.ok(!o.confirmInstall(fresh, "W", { ...o.DEFAULT_CHOICES, fg: 4 }).lines.some((l) => l.includes("XESS_FG=2")));
});

// ---- copyopts and autolaunch with OptiScaler ----------------------------------------------------------------------

test("copyLine applies the plan for an OptiScaler game and never suggests what it drops", () => {
  const base = { steam: true, draft: "", wanted: null, appid: "292030", autoOn: false, running: false };
  const c = copyLine({ ...base, text: "XESS=latest %command%", suggest: [{ key: "XESS", value: "latest", why: "" }], opti: P2 });
  assert.equal(c.line, "XESS_FG=2 WINEDLLOVERRIDES=dxgi=n,b %command% -dx12");
  assert.match(c.adds, /XESS_FG=2/);
  assert.match(c.adds, /WINEDLLOVERRIDES=dxgi=n,b/);
  assert.equal(c.reason, "advice");
  // already applied: the line is Steam's text, nothing added
  const same = copyLine({ ...base, text: c.line, opti: P2 });
  assert.equal(same.line, c.line);
  assert.equal(same.adds, "");
  assert.equal(same.reason, "current");
  // a refused write is the base, the plan goes on it too
  assert.equal(copyLine({ ...base, text: "", wanted: "FSR=xess %command%", opti: P2 }).line, "XESS_FG=2 WINEDLLOVERRIDES=dxgi=n,b %command% -dx12");
  // without a plan, unchanged behaviour
  assert.equal(copyLine({ ...base, text: "%command%", suggest: [{ key: "XESS", value: "latest" }] }).line, "XESS=latest %command%");
});

test("autolaunch.plan skips the keys OptiScaler drops", () => {
  const suggest = [{ key: "XESS", value: "latest", why: "old" }, { key: "MESA", value: "26.1", why: "x" }];
  assert.equal(autoPlan("%command%", suggest, undefined, [], o.OPTI_DROPPED).text, "MESA=26.1 %command%");
  assert.equal(autoPlan("%command%", suggest, undefined, []).text, "XESS=latest MESA=26.1 %command%");
});

// ---- the wiring (the components need Steam's React, so their source is checked) -----------------------------------

test("every OptiScaler control has its game.opti tag and a running check before writing", () => {
  const s = src("components/OptiControls.tsx");
  for (const id of ["game.opti", "game.opti_upscaler", "game.opti_fg", "game.opti_input", "game.opti_remove", "game.opti_update", "game.opti_overlay"]) {
    assert.equal(EFFECTS[id], "game", id);
    assert.match(s, new RegExp(`explainWhen\\([^\\n]*EFFECTS\\["${id.replace(".", "\\.")}"\\]`), `${id}: no explainWhen with its tag`);
  }
  const writes = [...s.matchAll(/setLaunchOptions\(appid/g)];
  assert.equal(writes.length, 1);
  const before = s.slice(Math.max(0, writes[0].index - 300), writes[0].index);
  assert.match(before, /if \(isRunning\(appid\)\) return \{ \.\.\.none, waiting: true/, "a running check right before the write");
  assert.match(s, /const quit = running \? `Quit \$\{app\.name\} first\.` : null;/);
  // a job's launch plan is applied only after it ended done (afterJob), never at its start
  assert.match(s, /afterJob\(r\.job\.id, \(j\) => \{[\s\S]*if \(j\.state !== "done" \|\| !out\?\.ok\) \{[\s\S]{0,400}?\n        return;\n      \}/);
  // a failed update that already removed OptiScaler: its launch options come out as for Remove
  assert.match(s, /if \(kind === "update"\) \{\s*void opti_info\(appid\)\.then\(\(r\) => \{\s*if \(r\.ok && r\.opti\?\.state === "none"\) syncLaunch\(null, "game\.opti_remove", "OptiScaler removed"\);/);
  // the Upscaler's Details show the ini value that is written (ffx for FSR 3.1 in DirectX 12), by the game's API
  assert.match(s, /lines: \[upscalerIni\(setup\.api, choices\.upscaler\)\]/);
  assert.equal(o.upscalerIni("dx12", "fsr31"), "Upscalers Dx12Upscaler=ffx");
  assert.equal(o.upscalerIni("dx11", "fsr31"), "Upscalers Dx11Upscaler=fsr31");
  assert.equal(o.upscalerIni("vulkan", "xess"), "Upscalers VulkanUpscaler=xess");
  // frame generation only for a DirectX 12 game: the dropdown offers Off only and is greyed
  assert.match(s, /disabled=\{!!act\.busy \|\| !info \|\| !!why \|\| !fgOk\} rgOptions=\{fgs\}/);
  // no backup promise: every conflict is a refusal
  assert.doesNotMatch(s, /moved into a backup folder/);
  // the install, update and remove ask first
  assert.match(s, /if \(!\(await confirm\(\{ title: c\.title,[\s\S]{0,200}effect: c\.effect \}\)\)\) return null;/);
  // the game setting it replaces and the FPS counter: Games tab only
  assert.match(s, /\{!quick && fgOk && \(\s*<WithDetails details=\{inputD\}>/);
  assert.match(s, /\{!quick && installed && \(\s*<WithDetails details=\{overlayD\}>/);
});

test("GameControls: the OptiScaler section for a table game, the XeSS options greyed while it is in", () => {
  const s = src("components/GameControls.tsx");
  assert.match(s, /\{optiEntry && \(\s*<PanelSectionRow>\s*<OptiRows /);
  assert.match(s, /const optiWhy = optiOn \? "Set by OptiScaler for this game\." : null;/);
  // after an OptiScaler job the shared opti-info resource (reloaded by OptiRows) decides, not game_info's flag
  assert.match(s, /const optiOn = steam && \(oi\.data\?\.ok \? \["installed", "partial"\]\.includes\(oi\.data\.opti\?\.state \?\? ""\) : !!game\?\.opti_installed\);/);
  for (const id of ["game.xess", "game.fg", "game.vendor", "game.fsr"]) {
    assert.match(s, new RegExp(`EFFECTS\\["${id.replace(".", "\\.")}"\\], xWhy\\)`), id);
  }
  assert.match(s, /opti: optiPlan,/, "Copy launch options gets the plan");
  assert.match(s, /optiOn \? `Without OptiScaler: \$\{i\.detail\}` : i\.detail/);
  // the exit watch applies a waiting OptiScaler change before the automatic setup's pass
  const a = src("components/AutoSetup.tsx");
  const flow = a.slice(a.indexOf("export const exitFlow"), a.indexOf("export const AUTO_AFTER_EXIT_MS"));
  const opti = flow.indexOf("await optiApplyPending(appid, name)"), sess = flow.indexOf("await sessions.get(appid)"), pass = flow.indexOf('await autoPass(appid, name, "exit")');
  assert.ok(opti > 0 && sess > opti && pass > sess, "OptiScaler's waiting options, then the session exit, then the pass");
  assert.match(a, /if \(!isRunning\(left\.appid\)\) exitFlow\(left\.appid, left\.name\)/);
});

test("api.ts and backend.ts have every OptiScaler call", () => {
  const api = src("api.ts");
  const b = src("backend.ts");
  for (const n of ["opti_info", "opti_install", "opti_set", "opti_remove", "opti_update", "opti_options"]) {
    assert.match(api, new RegExp(`export const ${n} = callable<`), n);
    assert.match(b, new RegExp(`export const ${n} = guard\\("${n}", \\{`), n);
  }
});

// ---- any game (DESIGN.md "OptiScaler for any game") ---------------------------------------------------------------

test("setupOf: an older backend's answer is the tested setup; known and generic texts", () => {
  assert.deepEqual(o.setupOf({}), { kind: "tested", api: "dx12", pick: null, name: null });
  assert.deepEqual(o.setupOf(null), { kind: "tested", api: "dx12", pick: null, name: null });
  const gen = o.setupOf({ kind: "generic", api: "vulkan", pick: null });
  assert.equal(o.fgPossible(gen), false);
  assert.equal(o.checklistLine("upscaler", 0, gen), "Pick DLSS, FSR or XeSS in the game, then restart it once.");
  // frame generation is never offered in the texts for a Vulkan or DirectX 11 game
  assert.equal(o.checklistLine("dlssg", 2, gen), "Pick DLSS, FSR or XeSS in the game, then restart it once.");
  assert.doesNotMatch(o.checklist("dlssg", 2, gen).join(" "), /Frame Generation|XeFG|Borderless/);
  assert.match(o.checklist("upscaler", 0, gen)[0], /set up for Vulkan/);
  assert.match(o.checklist("upscaler", 0, o.setupOf({ kind: "generic", api: "dx12" }))[1], /whichever the game offers/);
  const known = o.setupOf({ kind: "known", api: "dx12", pick: "FSR 3.1" });
  assert.equal(o.checklistLine("fsrfg", 2, known), "Pick FSR 3.1 and FSR frame generation, then restart the game.");
  assert.match(o.checklist("fsrfg", 2, known).join(" "), /Upscaling: FSR 3\.1 \(any quality\)\. .*FSR Frame Generation on/);
  assert.equal(o.readyToast("Lies of P", "fsrfg", 2, known), "OptiScaler ready for Lies of P: pick FSR 3.1 and FSR frame generation in the game.");
  assert.equal(o.readyToast("V", "dlssg", 2, gen), "OptiScaler ready for V: pick DLSS, FSR or XeSS in the game.");
  assert.notDeepEqual(o.checklistHelp(gen), o.CHECKLIST_HELP);
  assert.deepEqual(o.checklistHelp(o.TESTED), o.CHECKLIST_HELP);
  // a long pick still gives a line of at most 80 characters
  const long = o.setupOf({ kind: "known", api: "dx12", pick: "DLSS (pick it again after each start), or anything else it offers" });
  for (const f of [0, 2]) assert.ok(o.checklistLine("dlssg", f, long).length <= MAX_LINE);
  assert.ok(o.INPUTS.some((i) => i.data === "fsrfg"));
  assert.deepEqual(o.readChoices({ upscaler: "xess", fg: 0, fg_input: "fsrfg" }), { upscaler: "xess", fg: 0, fg_input: "fsrfg" });
});

test("install line, status and dialog by setup", () => {
  const VAR = /\b(XESS|XESS_FG|FSR_FG|WINEDLLOVERRIDES|DXVK_CONFIG|force_vk_vendor)\b|=/;
  for (const info of [{}, { kind: "known" }, { kind: "known", fit: "poor" }, { kind: "generic" }]) {
    const l = o.installLine(info);
    assert.ok(l.length <= MAX_LINE, l);
    assert.doesNotMatch(l, VAR, l);
  }
  assert.equal(o.installLine({}), "Runs XeSS and XeSS frame generation in place of the game's DLSS.");
  assert.match(o.installLine({ kind: "generic" }), /^Experimental/);
  assert.equal(o.statusLine({ state: "none", kind: "generic" }), "Not installed · experimental");
  const info = { kind: "generic", api: "dx11", api_why: "the exe loads d3d11.dll", exe: "game.exe", proxy: "winmm",
    folder: "/g/bin", cached: true, fg_ok: false };
  const c = o.confirmInstall(info, "Plain Game", { upscaler: "fsr31", fg: 2, fg_input: "upscaler" });
  assert.match(c.text[1], /It runs FSR 3\.1 when the game asks for DLSS, FSR or XeSS\. It goes in as winmm\.dll, a name the folder does not have/);
  assert.ok(c.text.some((t) => t.startsWith("Experimental:")));
  assert.ok(c.lines.includes("Next to: game.exe (DirectX 11: the exe loads d3d11.dll)"));
  assert.ok(c.lines.includes("As: winmm.dll"));
  // the tested game's dialog is unchanged
  assert.match(o.confirmInstall({ cached: true }, "W", o.DEFAULT_CHOICES).text[1], /Install stops if the folder already has a dxgi\.dll or another OptiScaler/);
});

test("OptiControls: every game's row, the setup's texts", () => {
  const s = src("components/OptiControls.tsx");
  assert.match(s, /description=\{explainWhen\(installLine\(info\), EFFECTS\["game\.opti"\]/);
  assert.match(s, /checklistLine\(choices\.fg_input, choices\.fg, setup\)/);
  assert.match(s, /checklist\(choices\.fg_input, choices\.fg, setup\), \.\.\.checklistHelp\(setup\)/);
  assert.match(s, /readyToast\(app\.name, choices\.fg_input, choices\.fg, setup\)/);
  // the games backend answers opti_entry for every Steam game; the component still checks it (older backends)
  assert.match(s, /if \(!isSteamApp\(appid\) \|\| !game\?\.opti_entry\) return null;/);
});
