// Tests for src/boundary.ts and the wiring of the error boundaries and the Problem rows' Retry / Copy (ROADMAP N-3).
// Run from the repository root: node --test tests/js
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import "./tsresolve.mjs";

const { CRASH_LABEL, crashLine, crashText, errorMessage, problemText } = await import("../../src/boundary.ts");

const src = (name) => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const sources = () => ["components", "pages"].flatMap((d) =>
  readdirSync(new URL(`../../src/${d}/`, import.meta.url)).filter((n) => n.endsWith(".tsx")).map((n) => [`${d}/${n}`, src(`${d}/${n}`)]));

test("errorMessage: whatever was thrown", () => {
  assert.equal(errorMessage(new TypeError("x is undefined")), "x is undefined");
  assert.equal(errorMessage(new Error("")), "Error");
  assert.equal(errorMessage("boom"), "boom");
  assert.equal(errorMessage(""), "unknown error");
  assert.equal(errorMessage({ code: 3 }), '{"code":3}');
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
  const loop = {}; loop.self = loop;
  assert.equal(errorMessage(loop), "[object Object]");
});

test("crashLine is one short line; the label is plain", () => {
  assert.equal(CRASH_LABEL, "This section hit an error");
  const long = new Error(`Cannot read properties of undefined (reading 'x'). ${"word ".repeat(60)}`);
  assert.ok(crashLine(long).length <= 101, crashLine(long));
  assert.equal(crashLine(new Error("short")), "short");
});

test("crashText: where, the message, the stack and the component stack, without repeating the message", () => {
  const e = new TypeError("bad value");
  e.stack = "TypeError: bad value\n    at PowerBody (index.js:10:5)\n    at renderWithHooks (react.js:1:1)";
  const t = crashText("Power", e, "\n    in PowerBody\n    in Group\n");
  const lines = t.split("\n");
  assert.equal(lines[0], "OXP3 Deck: Power: this section hit an error");
  assert.equal(lines[1], "bad value");
  assert.ok(lines.includes("Stack:") && lines.includes("at PowerBody (index.js:10:5)"));
  assert.ok(!lines.includes("TypeError: bad value"), "the message is not repeated from the stack");
  assert.ok(lines.includes("Components:") && lines.includes("in Group"));
  assert.equal(crashText("Live", "oops"), "OXP3 Deck: Live: this section hit an error\noops");
  const deep = new Error("deep");
  deep.stack = ["Error: deep", ...Array.from({ length: 40 }, (_, i) => `at f${i}`)].join("\n");
  assert.ok(crashText("X", deep).split("\n").length < 20, "the stack is cut");
});

test("problemText: the row's title and the whole error", () => {
  assert.equal(problemText("Power", "  refused: PL1 is locked.  "), "Power: did not work\nrefused: PL1 is locked.");
  assert.equal(problemText(undefined, "x"), "Did not work\nx");
});

test("the boundary: our own class that catches, logs, and remounts on Retry; Copy details through clipboard.ts", () => {
  const b = src("components/Boundary.tsx");
  assert.match(b, /class Boundary extends Component/);
  assert.match(b, /static getDerivedStateFromError/);
  assert.match(b, /componentDidCatch\(/);
  assert.match(b, /retry = \(\) => this\.setState\(\{ failed: false/);
  assert.match(b, /<RetryCopy copy=\{text\} onRetry=\{this\.retry\} copyLabel="Copy details" \/>/);
  assert.doesNotMatch(b, /import \{[^}]*ErrorBoundary[^}]*\} from "@decky\/ui"/, "not Steam's (found at run time)");
  const h = src("components/Hint.tsx");
  assert.match(h, /import \{ copyText \} from "\.\.\/clipboard"/);
  assert.match(h, /<Focusable flow-children="horizontal"/, "Retry and Copy: one row the D-pad moves across");
  assert.match(h, /showDetails\(\{ title: "Couldn't copy"/, "the text stays readable when no clipboard method works");
});

test("every Quick Access group's body and closed rows, the panel, and every full-page tab are inside a Boundary", () => {
  const g = src("components/Group.tsx");
  assert.match(g, /<Boundary key="body" what=\{title\}><GroupCtx\.Provider value=\{id\}>\{children\}<\/GroupCtx\.Provider><\/Boundary>/);
  assert.match(g, /<Boundary key="alerts" what=\{title\}>\s*\{alerts\}/);
  const f = src("pages/Full.tsx");
  assert.match(f, /\]\.map\(\(p\) => \(\{ \.\.\.p, content: <Boundary key=\{p\.route\} what=\{p\.title\} wrap="section">\{p\.content\}<\/Boundary> \}\)\)/);
  assert.match(f, /export const FullPageRoute: FC = \(\) => <Boundary what="All settings" wrap="section"><FullPage \/><\/Boundary>/);
  const i = src("index.tsx");
  assert.match(i, /routerHook\.addRoute\(ROUTE, FullPageRoute,/);
  assert.match(i, /content: <Boundary what="Quick Access panel" wrap="section"><QuickPanel \/><\/Boundary>/);
  assert.match(src("pages/Quick.tsx"), /<Boundary what="Status" wrap="section"><StatusSection /);
});

test("Problem rows: Copy always, Retry where the failed step is known", () => {
  const h = src("components/Hint.tsx");
  const p = h.slice(h.indexOf("export const Problem"), h.indexOf("/** Plain information"));
  assert.match(p, /<RetryCopy copy=\{problemText\(what, error\)\} onRetry=\{onRetry\} \/>/);
  // useAction: retry runs the last action again, only while its error shows and nothing runs
  const a = src("actions.tsx");
  assert.match(a, /const retry = error && l && !busy \? \(\) => run\(l\.name, l\.fn\) : null;/);
  // every Problem row of a useAction error, or of a resource that failed to load, offers Retry
  for (const [name, s] of sources()) {
    for (const m of s.matchAll(/<Problem [^>]*?\/>/g)) {
      const row = m[0];
      if (/error=\{\(?(?:\(alerts \? null : )?(?:\w+\.busy \? null : )?(act|inst|drv|shim|oxp|xes|diag)\.error\b/.test(row)) {
        assert.match(row, /onRetry=\{[^}]*\b(act|inst|drv|shim|oxp|xes|diag)\.retry\b/, `${name}: ${row}`);
      }
      if (/error=\{\(?(\w+)\.data && !\1\.data\.ok \? \1\.data\.error : null\)?\}/.test(row)) {
        assert.match(row, /onRetry=\{\w+\.reload\}/, `${name}: ${row}`);
      }
    }
  }
});
