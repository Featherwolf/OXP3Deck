// Tests for src/files.ts and the wiring of the settings-file rows (ROADMAP T1-5). Run from the repository root:
// node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const { fileName, fileRow } = await import("../../src/files.ts");
const { MAX_LINE } = await import("../../src/text.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

const damaged = { file: "auto.json", kind: "damaged", copy: "auto.json.corrupt-20261123-101500", action: "fresh" };
const newer = { file: "optiscaler.json", kind: "newer", version: 2, action: "fresh" };
const reset = { file: "power.json", kind: "reset", copy: "power.json.corrupt-20261123-101500", action: "dismiss" };

test("names: plain words, an unknown file as itself", () => {
  assert.equal(fileName("auto.json"), "Automatic setup");
  assert.equal(fileName("power.json"), "Power settings");
  assert.equal(fileName("other.json"), "other.json");
});

test("a damaged file waits for Start fresh, which asks first", () => {
  const r = fileRow(damaged);
  assert.equal(r.label, "Automatic setup: file damaged");
  assert.equal(r.line, "Saving is paused. A copy is kept.");
  assert.equal(r.button, "Start fresh");
  assert.ok(r.ask && r.ask.ok === "Start fresh");
  assert.match(r.ask.text, /no longer lists them/);
  assert.deepEqual(r.details.lines, ["file: auto.json", "copy: auto.json.corrupt-20261123-101500"]);
});

test("a newer file: the row the roadmap names, read-only", () => {
  const r = fileRow(newer);
  assert.equal(r.label, "Settings are from a newer OXP3 Deck");
  assert.equal(r.line, "OptiScaler is read-only here. Update OXP3 Deck.");
  assert.equal(r.button, "Start fresh");
  assert.ok(r.ask);
  assert.ok(r.details.lines.includes("version: 2"));
});

test("another file that already started empty: OK, no question", () => {
  const r = fileRow(reset);
  assert.equal(r.label, "Power settings: file was damaged");
  assert.equal(r.button, "OK");
  assert.equal(r.ask, null);
});

test("every up-front text is one short line without paths", () => {
  for (const p of [damaged, newer, reset, { ...damaged, file: "optiscaler.json" }]) {
    const r = fileRow(p);
    for (const t of [r.label, r.line]) {
      assert.ok(t.length <= MAX_LINE, t);
      assert.doesNotMatch(t, /\.json|\//, t);
    }
  }
});

test("wiring: the Status section and Updates show the rows; file_fresh is a backend call", () => {
  assert.match(src("pages/Quick.tsx"), /<FileRows files=\{o\?\.files\} \/>/);
  assert.match(src("pages/Updates.tsx"), /<FileRows files=\{o\.files\} \/>/);
  assert.match(src("api.ts"), /export const file_fresh = callable<\[file: string\], FileFreshRes>\("file_fresh"\);/);
  assert.match(src("backend.ts"), /export const file_fresh = guard\("file_fresh"/);
  const rows = src("components/FileRows.tsx");
  assert.match(rows, /confirm\(/);
  assert.match(rows, /<Problem /);
});
