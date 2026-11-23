// Tests for src/latest.ts: the latest-wins queue behind the per-game profile switch (store.ts switchGame).
// Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeLatest } from "../../src/latest.ts";

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

/** A send whose calls resolve or reject when the test says so. */
const fakeSend = () => {
  const calls = [];
  const send = (value, seq) => new Promise((resolve, reject) => { calls.push({ value, seq, resolve, reject }); });
  return { calls, send };
};
const tick = () => new Promise((r) => setImmediate(r));

test("the first push goes at once, with seq 1", () => {
  const f = fakeSend();
  const q = makeLatest(f.send);
  q.push("A");
  assert.deepEqual(f.calls.map((c) => [c.value, c.seq]), [["A", 1]]);
  assert.equal(q.busy(), true);
});

test("one call at a time: only the newest waiting push goes after the one in flight", async () => {
  const f = fakeSend();
  const answers = [];
  const q = makeLatest(f.send, { onAnswer: (r, v, stale) => answers.push([r, v, stale]) });
  q.push("A");
  q.push(null);
  q.push("B");
  assert.equal(f.calls.length, 1);                 // A in flight, B replaced null while it waited
  f.calls[0].resolve("a");
  await tick();
  assert.deepEqual(f.calls.map((c) => [c.value, c.seq]), [["A", 1], ["B", 3]]);
  assert.deepEqual(answers, [["a", "A", true]]);   // A's answer is stale: B came after it
  f.calls[1].resolve("b");
  await tick();
  assert.deepEqual(answers, [["a", "A", true], ["b", "B", false]]);
  assert.equal(q.busy(), false);
});

test("a rejected or throwing send reaches onError and the next one still goes", async () => {
  const f = fakeSend();
  const errors = [];
  const answers = [];
  const q = makeLatest(f.send, { onError: (e, v, stale) => errors.push([e.message, v, stale]), onAnswer: (r) => answers.push(r) });
  q.push("A");
  q.push("B");
  f.calls[0].reject(new Error("gone"));
  await tick();
  assert.deepEqual(errors, [["gone", "A", true]]);
  assert.equal(f.calls.length, 2);
  f.calls[1].reject(new Error("still gone"));
  await tick();
  assert.deepEqual(errors, [["gone", "A", true], ["still gone", "B", false]]);

  const thrown = [];
  const q2 = makeLatest(() => { throw new Error("sync"); }, { onError: (e, v, stale) => thrown.push([e.message, v, stale]) });
  q2.push("C");
  await tick();
  assert.deepEqual(thrown, [["sync", "C", false]]);
  assert.equal(q2.busy(), false);
});

test("a failing callback does not stop the queue", async () => {
  const f = fakeSend();
  const q = makeLatest(f.send, { onAnswer: () => { throw new Error("dead subscriber"); } });
  q.push("A");
  q.push("B");
  f.calls[0].resolve("a");
  await tick();
  assert.equal(f.calls.length, 2);
});

test("idle() resolves once nothing waits or is in flight", async () => {
  const f = fakeSend();
  const q = makeLatest(f.send);
  await q.idle();                                  // nothing queued: at once
  q.push("A");
  q.push("B");
  let done = false;
  q.idle().then(() => { done = true; });
  f.calls[0].resolve("a");
  await tick();
  assert.equal(done, false);
  f.calls[1].resolve("b");
  await tick();
  assert.equal(done, true);
});

test("index.tsx switches games through the queue; store.ts sends an order and shows failures", () => {
  const s = src("index.tsx");
  assert.match(s, /const stopPower = onMainAppChange\(\(a\) => switchGame\(a\)\)/);
  assert.match(s, /switchGame\(runningApp\(\)\?\.appid \?\? null\)/);
  assert.doesNotMatch(s, /power_game\(/);
  const st = src("store.ts");
  assert.match(st, /makeLatest\(\(appid: string \| null, seq: number\) => power_game\(appid, \[SESSION, seq\]\)/);
  assert.match(st, /if \(!stale\) setGameError\(notePower\(r\)\)/);
  assert.match(st, /onError: /);
  const pc = src("components/PowerControls.tsx");
  assert.match(pc, /<Problem what="Game profile switch" error=\{switchError\} onRetry=\{retrySwitch\} \/>/);
});
