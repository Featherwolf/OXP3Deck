// The pages need Steam's React, so these check their source for the wiring the review fixes rely on (FE-1, FE-2,
// FE-4); the decisions themselves are tested in xessoffer.test.mjs.
// Run from decky/: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const PAGES = ["pages/Quick.tsx", "pages/XeSS.tsx", "pages/Updates.tsx"];

test("every xess install button goes through xessOffer, and its confirmation gets the same offer (FE-1, FE-4)", () => {
  for (const name of PAGES) {
    const s = src(name);
    assert.match(s, /xessOffer\(/, name);
    assert.match(s, /installXess\((offer|xOffer), /, `${name}: installXess(offer, ...)`);
    assert.doesNotMatch(s, /[Ll]atest !== /, `${name}: a tag compared by inequality`);
    assert.doesNotMatch(s, /`Update to \$\{/, `${name}: an "Update to" label of its own (offerLabel has the rule)`);
  }
  assert.match(src("actions.tsx"), /export const installXess = async \(offer: XessOffer,/);
});

test("the quick panel's oxp3-tool install button shows its own error, also while oxp3-tool is not usable (FE-2)", () => {
  const s = src("pages/Quick.tsx");
  const section = s.slice(s.indexOf("const Oxp3Section"), s.indexOf("const XessSection"));
  assert.match(section, /inst\.run\("oxp3-tool"/);
  const problem = section.indexOf("error={inst.busy ? null : inst.error}");
  assert.ok(problem > 0, "a Problem row for the install button");
  assert.ok(problem < section.indexOf("{usable && status && ("), "the Problem row is outside the usable-only rows");
});

test("the XeSS tab says when a package script from before a plugin restart still runs (RT-1)", () => {
  // the backend refuses the xess buttons meanwhile; the README promises the page says why
  assert.match(src("pages/XeSS.tsx"), /\{x\?\.script_running && \(/);
});

test("the install confirmation asks for xess_state when the page has none (RC-1)", () => {
  // the lines on the system Protons (shimmed as root) and the driver come from xess_state
  const s = src("actions.tsx");
  const fn = s.slice(s.indexOf("export const installXess"), s.indexOf("export const uninstallXess"));
  assert.match(fn, /const state = x \?\? await xess_state\(\)/);
  assert.match(fn, /installLines\(offer, state, user\)/);
});

test("old folders xess_remove_folder always refuses get no Remove button (RC-2)", () => {
  const s = src("pages/XeSS.tsx");
  assert.match(s, /\(x\.old_folders_kept \?\? \[\]\)\.map\(\(k\) => \(\s*<Note key=\{k\.path\}/);
  assert.match(s, /x\.old_folders\.map\(\(p\) => <PanelSectionRow key=\{p\}><OldFolder /);
  assert.doesNotMatch(s, /old_folders_kept[^\n]*<OldFolder/);
});

test("index.tsx follows the running app for power_game and stops it in onDismount", () => {
  const s = src("index.tsx");
  assert.match(s, /const stopPower = onMainAppChange\(\(a\) => \{ power_game\(a\)\.then\(notePower\); \}\)/);
  assert.match(s, /power_game\(runningApp\(\)\?\.appid \?\? null\)\.then\(notePower\)/);
  const dismount = s.slice(s.indexOf("onDismount()"));
  assert.match(dismount, /stopPower\(\)/);
});

test("power values go through the writer only, never power_set from a control", () => {
  for (const name of ["components/PowerControls.tsx", "pages/Power.tsx", "pages/Quick.tsx"]) {
    const s = src(name);
    assert.doesNotMatch(s, /power_set\(/, `${name} calls power_set`);
    assert.doesNotMatch(s, /onChange=\{[^}]*power_set/, `${name}: power_set in an onChange`);
  }
  assert.match(src("store.ts"), /export const powerWriter = makeWriter\(power_set,/);
  assert.match(src("components/PowerControls.tsx"), /powerWriter\.write\(key, slot, values\)/);
});

test("the quick panel shows Power after Status and before oxp3-tool", () => {
  const s = src("pages/Quick.tsx");
  const body = s.slice(s.indexOf("export const QuickPanel"));
  const status = body.indexOf("<StatusSection"), power = body.indexOf("<PowerSection quick"), oxp3 = body.indexOf("<Oxp3Section");
  assert.ok(status > 0 && power > status && oxp3 > power, "Status, Power, oxp3-tool");
});

test("the full page has the Power tab first", () => {
  const s = src("pages/Full.tsx");
  const pages = s.slice(s.indexOf("pages={["));
  assert.match(pages, /^pages=\{\[\s*\{ title: "Power", icon: <MdBolt \/>, route: `\$\{ROUTE\}\/power`, content: <PowerTab \/> \}/);
});

test("power-state is polled only while active (it wakes the GPU)", () => {
  const s = src("store.ts");
  const fn = s.slice(s.indexOf("export const usePowerState"));
  assert.match(fn, /\{ skip: !active/);
  assert.match(fn, /if \(!active\) return undefined;/);
  assert.match(src("components/PowerControls.tsx"), /const shows = !quick \|\| visible;\n\s*const p = usePower\(shows\);/);
});

test("every power call in api.ts is wrapped in backend.ts with an empty state", () => {
  const api = src("api.ts");
  const names = [...api.matchAll(/callable<.*?>\("(power_[a-z_]+)"\)/g)].map((m) => m[1]);
  assert.equal(names.length, 12);
  const b = src("backend.ts");
  for (const n of names) assert.match(b, new RegExp(`export const ${n} = guard\\("${n}", `), n);
});

// ---- one line up front, the rest in Details (DESIGN.md "Frontend → Details") ----------------------------------------

import { readdirSync } from "node:fs";

const SRC = new URL("../../src/", import.meta.url);
const allSources = () => {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`, `${rel}${e.name}/`);
      else if (/\.tsx?$/.test(e.name)) out.push(`${rel}${e.name}`);
    }
  };
  walk("", "");
  return out;
};

/** The argument text of the call starting at `open` (the index of its "("), and whether it has a top-level comma. */
const callArgs = (s, open) => {
  const stack = [];         // ")", "]", "}" or "`" (a template literal), innermost last
  let comma = false;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i], top = stack[stack.length - 1];
    if (top === "`") {
      if (c === "\\") { i++; continue; }
      if (c === "`") stack.pop();
      else if (c === "$" && s[i + 1] === "{") { stack.push("}"); i++; }
      continue;
    }
    if (c === "'" || c === '"') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
      continue;
    }
    if (c === "`") { stack.push("`"); continue; }
    if (c === "(") stack.push(")");
    else if (c === "[") stack.push("]");
    else if (c === "{") stack.push("}");
    else if (c === ")" && !stack.length) return { text: s.slice(open + 1, i), comma };
    else if (c === ")" || c === "]" || c === "}") stack.pop();
    else if (c === "," && !stack.length) comma = true;
  }
  return { text: s.slice(open + 1), comma };
};

test("explain() takes one sentence: no call passes a second argument", () => {
  for (const name of allSources()) {
    const s = src(name);
    for (const m of s.matchAll(/\bexplain\(/g)) {
      if (s.slice(m.index - 20, m.index).includes("const ")) continue;      // the definition
      const a = callArgs(s, m.index + "explain".length);
      assert.ok(!a.comma, `${name}: explain(${a.text.slice(0, 60)}…) has a second argument`);
      assert.doesNotMatch(a.text, /sudo /, `${name}: "sudo" in a one-liner`);
    }
  }
});

test("no hover tooltips, no Steam explainer: Details is the one mechanism", () => {
  for (const name of allSources()) {
    const s = src(name);
    assert.doesNotMatch(s, /\btooltip=/, `${name}: tooltip=`);
    assert.doesNotMatch(s, /\bexplainer=/, `${name}: explainer=`);
    assert.doesNotMatch(s, /description="[^"]*sudo /, `${name}: "sudo" in a description`);
  }
});

test("WithDetails opens Details with the Options button; read-only rows open them with A too", () => {
  const h = src("components/Hint.tsx");
  assert.match(h, /onOptionsButton=\{\(\) => showDetails\(details\)\} onOptionsActionDescription="Details"/);
  assert.match(h, /onActivate: \(\) => showDetails\(details\)/);
  assert.match(h, /export const INFO = " ⓘ";/);
  assert.match(h, /firstSentence\(error, 100\)/, "Problem shows the error's first sentence");
  assert.match(src("components/confirm.tsx"), /<ConfirmModal bAlertDialog strTitle=\{d\.title\}[^>]*strOKButtonText="Close"/);
});

test("the power controls and the Power tab render the conflict rows (Fix for me)", () => {
  assert.match(src("components/PowerControls.tsx"), /<ConflictRows /);
  assert.match(src("pages/Power.tsx"), /<ConflictRow /);
  assert.match(src("pages/Power.tsx"), /<FixedRows info=\{info\} \/>/);
  // under energy preference and CPU boost while a conflict locks them
  assert.match(src("components/PowerControls.tsx"), /const cpuRows = cpuOff && lockers\.length > 0 \? <ConflictRows rows=\{lockers\}/);
});

test("power_fix and power_unfix run only after a confirm in the same flow, never on their own", () => {
  for (const name of allSources()) {
    if (name === "api.ts" || name === "backend.ts") continue;
    const s = src(name);
    for (const m of s.matchAll(/\bpower_(un)?fix\(/g)) {
      const start = s.lastIndexOf("act.run(", m.index);
      assert.ok(start >= 0, `${name}: ${m[0]} outside a button's act.run`);
      const flow = s.slice(start, m.index);
      assert.match(flow, /if \(!\(await confirm\(/, `${name}: ${m[0]} without a confirm before it`);
    }
  }
  // nothing else calls them: no effect, no timer
  const users = allSources().filter((n) => n !== "api.ts" && n !== "backend.ts" && /\bpower_(un)?fix\(/.test(src(n)));
  assert.deepEqual(users, ["components/ConflictRow.tsx"]);
  assert.doesNotMatch(src("components/ConflictRow.tsx"), /useEffect\([^)]*power_(un)?fix/);
});

test("a fix's answer refreshes the caches at once and once more after the backend's recheck", () => {
  const s = src("store.ts");
  assert.match(s, /export const FIX_RELOAD_MS = 12000;/);
  const fn = s.slice(s.indexOf("export const notePowerFix"));
  assert.match(fn, /put<PowerInfoRes>\("power-info", \{ \.\.\.cur, info: \{ \.\.\.cur\.info, conflicts: r\.conflicts, fixed: r\.fixed, state: r\.state \} \}\)/);
  assert.match(fn, /setTimeout\(\(\) => invalidate\("power-info"\), FIX_RELOAD_MS\)/);
  assert.match(src("components/ConflictRow.tsx"), /const err = notePowerFix\(r\);/);
});

// ---- 0.4: "When it takes effect", live readouts, extras, automatic launch options -----------------------------------

/** Selectors that change nothing carry no tag (DESIGN.md "When it takes effect"). */
const SELECTORS = ["Profile to edit", "Edit values for", "Show 5x–8x", "Show advanced CPU options"];

test("every setting control shows its effect tag (explainWhen), except the selectors", () => {
  let n = 0;
  for (const name of allSources().filter((x) => x.endsWith(".tsx"))) {
    const s = src(name);
    for (const m of s.matchAll(/<(ToggleField|SliderField|DropdownItem)\b/g)) {
      const end = s.indexOf("/>", m.index);
      const el = s.slice(m.index, end);
      if (SELECTORS.some((l) => el.includes(`"${l}`))) continue;
      n++;
      assert.match(el, /description=\{explainWhen\(/, `${name}: ${el.slice(0, 120)}… has no explainWhen`);
    }
  }
  assert.ok(n >= 30, `only ${n} controls found`);
});

test("every confirm dialog says when it takes effect", () => {
  let n = 0;
  for (const name of allSources()) {
    if (name === "components/confirm.tsx") continue;
    const s = src(name);
    for (const m of s.matchAll(/\bconfirm\(/g)) {
      if (/(const|export const) $/.test(s.slice(m.index - 13, m.index)) || /\w$/.test(s.slice(m.index - 1, m.index))) continue;
      const a = callArgs(s, m.index + "confirm".length);
      n++;
      assert.match(a.text, /\beffect[:,]|\beffect\b/, `${name}: confirm(${a.text.slice(0, 80)}…) has no effect`);
    }
  }
  assert.ok(n >= 15, `only ${n} confirms found`);
  // the dialogs built elsewhere carry it too
  assert.match(src("conflicts.ts"), /ok: "Turn it off",\n\s*effect: "now",/);
  assert.match(src("conflicts.ts"), /ok: "Turn it back on",\n\s*effect: "now",/);
  assert.match(src("components/confirm.tsx"), /\{o\.effect && <div[^>]*>\{confirmLine\(o\.effect\)\}<\/div>\}/);
});

test("automatic launch options never write while that game runs", () => {
  const s = src("components/AutoLaunch.tsx");
  const calls = [...s.matchAll(/setLaunchOptions\(appid/g)];
  assert.equal(calls.length, 2);
  for (const m of calls) {
    const before = s.slice(Math.max(0, m.index - 400), m.index);
    assert.match(before, /if \(isRunning\(appid\)\) \{?\s*(return|setErr)/, "a running check right before the write");
    const fnStart = Math.max(s.lastIndexOf("export const autoApply", m.index), s.lastIndexOf("const doUndo", m.index));
    assert.ok(before.length && s.slice(fnStart, m.index).includes("isRunning(appid)"), "in the same function");
  }
  // only AutoLaunch.tsx and GameControls (the user's own picks) write launch options
  const writers = allSources().filter((n) => !["steam.ts"].includes(n) && /\bsetLaunchOptions\(/.test(src(n)));
  assert.deepEqual(writers.sort(), ["components/AutoLaunch.tsx", "components/GameControls.tsx"]);
  assert.match(src("index.tsx"), /const stopAuto = watchGameExits\(\);/);
  assert.match(src("index.tsx"), /stopAuto\(\);/);
});

test("the live readouts are read only by useLive, only while active", () => {
  const users = allSources().filter((n) => n !== "api.ts" && n !== "backend.ts" && /\bpower_live\(/.test(src(n)));
  assert.deepEqual(users, ["store.ts"]);
  const s = src("store.ts");
  const fn = s.slice(s.indexOf("export const useLive"), s.indexOf("// ---- extras"));
  assert.match(fn, /if \(!active \|\| stopped\) return undefined;/);
  assert.match(fn, /power_live\(\)/);
  assert.match(fn, /LIVE_MS/);
  assert.match(s, /export const LIVE_MS = 1000;/);
  assert.match(src("components/PowerControls.tsx"), /<LiveRow active=\{shows\} \/>/);
});

test("the charge behaviour is never inhibit-charge (only auto and inhibit-charge-awake)", () => {
  for (const name of allSources()) {
    assert.doesNotMatch(src(name), /["']inhibit-charge["']/, `${name}: "inhibit-charge"`);
  }
  const s = src("components/ExtrasControls.tsx");
  for (const m of s.matchAll(/extras_set\(\{([^}]*)\}/g)) {
    if (m[1].includes("charge_behaviour")) assert.match(m[1], /charge_behaviour: on \? "inhibit-charge-awake" : "auto"/);
  }
});

test("the extras calls are in api.ts and wrapped in backend.ts", () => {
  const api = src("api.ts");
  const b = src("backend.ts");
  for (const n of ["power_live", "extras_info", "extras_set", "extras_take_control"]) {
    assert.match(api, new RegExp(`export const ${n} = callable<`), n);
    assert.match(b, new RegExp(`export const ${n} = guard\\("${n}", \\{ (live|extras): null \\}\\)`), n);
  }
});

test("review fixes: greyed-out reasons, pending rows after success, one error, one live poller", () => {
  // the XeSS installer is refused while a game runs: greyed out with the reason, not refused after the confirm
  for (const n of ["pages/XeSS.tsx", "pages/Quick.tsx", "pages/Updates.tsx"]) {
    assert.match(src(n), /useRunningApp\(\)/, n);
    assert.match(src(n), /Quit \$\{game\.name\} first\./, n);
  }
  assert.match(src("pages/XeSS.tsx"), /disabled=\{busy \|\| !!game\}/);
  assert.match(src("pages/XeSS.tsx"), /why=\{running \? "Wait for the running task\." : x\.relogin_needed \? "Log out and back in first\." : null\}/);
  assert.match(src("pages/Kernel.tsx"), /EFFECTS\["reboot"\], running \? "Wait for the running task\." : null\)/);
  // the default-driver dropdown is remounted only when the switch did not happen
  assert.match(src("pages/XeSS.tsx"), /\} else setDrvRev\(\(n\) => n \+ 1\);/);
  // a fix's log-out row only once its job is done
  const a = src("actions.tsx");
  assert.match(a, /afterJob\(r\.job\.id, \(j\) => \{\n\s*if \(j\.state === "done"\)/);
  assert.doesNotMatch(a, /if \(!err\) for \(const f of fixes\)/);
  // one Problem row per refused power_set
  assert.match(src("components/PowerControls.tsx"), /errors=\{!s\.enabled\}/);
  assert.match(src("pages/Power.tsx"), /battery=\{false\} errors=\{false\}/);
  // the Live Details do not repeat the GPU clock and the reason
  assert.doesNotMatch(src("components/LiveRows.tsx"), /Why it is slow/);
  // one shared poller; the Power tab stops while the page is hidden
  const s = src("store.ts");
  assert.match(s, /const liveSubs = new Set/);
  assert.match(src("components/LiveRows.tsx"), /useLive\(active && shown\)/);
  // no "Saved" next to the pending row while the game runs
  assert.match(src("components/GameControls.tsx"), /setSaved\(r\.ok && !\(running && what\)\);/);
});

test("the scheduler mode warns up front and asks first while a game runs and the profile is active", () => {
  const s = src("components/ExtrasControls.tsx");
  assert.match(s, /full: "Changing it while a game runs can freeze the game; change it before starting the game\."/);
  assert.match(s, /description=\{explainWhen\(SCX_WARN\.line, EFFECTS\["extras\.scx"\]/);
  assert.match(s, /if \(await scxGoAhead\(app, active\)\) write\(\{ scx_mode: m \}\);/);
  assert.match(s, /!running \|\| !applies \|\| await confirm\(/);
  assert.match(s, /if \(what === "scx" && !\(await scxGoAhead\(app, true\)\)\) return null;/);
  const line = /line: "([^"]+)"/.exec(s.slice(s.indexOf("export const SCX_WARN")))[1];
  assert.ok(line.length <= 80, line);
  // the Power tab passes whether the edited profile runs now
  assert.match(src("pages/Power.tsx"), /<ExtrasRows [^\n]*active=\{active\} \/>/);
});

test("frame generation: a known crash asks first, the general warning is in the Details", () => {
  const s = src("components/GameControls.tsx");
  assert.match(s, /export const FG_CRASH_LINE = "Frame generation can crash some games; if a game crashes, turn it off\.";/);
  assert.match(s, /if \(o\.data && !\(await risky\(fgIssue, /);
  assert.match(s, /if \(m\.data && !\(await risky\(fsrIssue, m\.label\)\)\) return;/);
  assert.match(s, /fgIssue \? "Crashes this game: leave it on Game default\."/);
  assert.match(s, /\(game\?\.known_issues \?\? \[\]\)\.map\(/);
  assert.match(s, /\(game\?\.checks \?\? \[\]\)\.map\(/);
});

test("the CPU status line shows the values in effect, and the quick panel shows it under the CPU controls", async () => {
  const { cpuNowLine } = await import("../../src/power.ts");
  const n = { cpu_max_pct: 60, cpu_min_pct: 9, epp: "balance_power", turbo: false, soc: { balance: 4, offset: 0, profile: "balanced", choices: [] } };
  assert.equal(cpuNowLine(n), "Cap 60 % · Min 9 % · Energy: Balance power · Boost: off · Balance 4 (balanced)");
  assert.equal(cpuNowLine({ epp: null, turbo: null, soc: null }), "Cap ? % · Min ? % · Energy: ? · Boost: ?");
  assert.match(src("pages/Power.tsx"), /label="CPU" detail=\{cpuNowLine\(n\)\}/);
  assert.match(src("components/PowerControls.tsx"), /label="CPU now" detail=\{cpuNowLine\(state\.now\)\}/);
  assert.match(src("components/PowerControls.tsx"), /\{state\.blocked && \(\s*<PanelSectionRow>\s*<Status ok=\{false\} label="Paused" detail="Changes are saved and apply once the other program stops\."/);
  assert.match(src("components/PowerControls.tsx"), /state\.now\.governor === "performance" && \(/);
  const cpu = src("components/CpuControls.tsx");
  assert.match(cpu, /On battery: the device's own floor \(\$\{minR\.lo\} %\) runs now\./);
  assert.match(cpu, /With CPU boost off the cores stop at their base speed, so a high cap changes nothing\./);
});

test("yieldedText names what an ignored program got back", async () => {
  const { yieldedText, GOVERNOR_PERFORMANCE } = await import("../../src/power.ts");
  assert.equal(yieldedText([], "x"), null);
  assert.equal(yieldedText(["epp"], "Power Profiles"), "Energy preference left to Power Profiles.");
  assert.equal(yieldedText(["epp", "turbo", "soc"], "it"), "Energy preference, CPU boost and the CPU vs GPU balance left to it.");
  assert.ok(GOVERNOR_PERFORMANCE.line.length <= 80);
  assert.match(GOVERNOR_PERFORMANCE.detail, /A reboot or the desktop's power settings reset it\./);
  assert.match(src("components/PowerControls.tsx"), /const yielded = yieldedText\(state\.yielded, ignoredOwner\);/);
});

test("no libxess_fg.dll counts only without an FSR route (FSR=xess / FSR_FG bring XeSS frame generation in)", () => {
  const s = src("components/GameControls.tsx");
  assert.match(s, /const noFgLib = game\?\.has_fg === false && !cur\.FSR && !cur\.FSR_FG;/);
  assert.doesNotMatch(s, /game\?\.has_fg === false \?/);
  assert.match(s, /\{steam && cur\.XESS_FG && noFgLib && \(/);
});

test("Start in DirectX 12: a per-game toggle that writes only its argument, with the effect tag", async () => {
  const s = src("components/GameControls.tsx");
  assert.match(s, /onChange=\{\(v\) => write\(setArg\(text, dxArg, v\), \{ id: "game\.dx12", label: "Start in DirectX 12" \}\)\}/);
  assert.match(s, /EFFECTS\["game\.dx12"\]/);
  assert.match(s, /"game\.dx12"/);
  assert.match(s, /Not every game knows \$\{dxArg\}/);
  const { EFFECTS, effectText } = await import("../../src/effects.ts");
  assert.equal(effectText(EFFECTS["game.dx12"]), "Restart the game");
  // the frame generation check: the log's time in the check's Details, how to turn the log on without one
  assert.match(s, /The log was written \$\{when\(c\.at\)\}/);
  assert.match(s, /turn on Save XeSS logs \(XESS_LOG=1\)/);
});
