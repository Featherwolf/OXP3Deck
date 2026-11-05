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
  assert.match(src("components/PowerControls.tsx"), /usePower\(!quick \|\| visible\)/);
});

test("every power call in api.ts is wrapped in backend.ts with an empty state", () => {
  const api = src("api.ts");
  const names = [...api.matchAll(/callable<.*?>\("(power_[a-z_]+)"\)/g)].map((m) => m[1]);
  assert.equal(names.length, 9);
  const b = src("backend.ts");
  for (const n of names) assert.match(b, new RegExp(`export const ${n} = guard\\("${n}", `), n);
});
