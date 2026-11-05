// Tests for src/text.ts. Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { firstSentence, fitsOneLine, MAX_LINE } from "../../src/text.ts";

test("MAX_LINE is the one-line limit of DESIGN.md", () => {
  assert.equal(MAX_LINE, 80);
});

test("firstSentence: up to the first '. ' or ': ' after 20 characters", () => {
  assert.equal(firstSentence("Power control is off. Turn it on to set power here."), "Power control is off.");
  assert.equal(firstSentence("power_fix: power-profiles-daemon is not running"), "power_fix: power-profiles-daemon is not running");
  assert.equal(firstSentence("could not list services: Failed to connect to bus: No such file"), "could not list services");
  // a stop inside the first 20 characters does not end it
  assert.equal(firstSentence("E.g. this is the first sentence. And more."), "E.g. this is the first sentence.");
});

test("firstSentence: a long text without a stop is cut at a word with …", () => {
  const long = "word ".repeat(40).trim();
  const out = firstSentence(long, 50);
  assert.ok(out.length <= 50, out);
  assert.ok(out.endsWith("…"));
  assert.doesNotMatch(out, /wor…$/);
  // a first sentence longer than max is cut too
  const s = `${"a".repeat(30)} ${"b".repeat(90)}. Rest.`;
  assert.ok(firstSentence(s, 60).length <= 60);
});

test("firstSentence: empty, null and whitespace", () => {
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(null), "");
  assert.equal(firstSentence("  two\n lines  "), "two lines");
});

test("fitsOneLine: true only when nothing would be left for Details", () => {
  assert.equal(fitsOneLine("Short."), true);
  assert.equal(fitsOneLine("This is the first sentence here. And a second one."), false);
  assert.equal(fitsOneLine("x ".repeat(60)), false);
});
