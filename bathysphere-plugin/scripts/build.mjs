// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
//
// Builds the plugin package into dist/ (SPEC §3.1): one ES2023 module main.js with no imports, the
// manifest, the assets and the package documents.
//
//   node scripts/build.mjs           build dist/
//   node scripts/build.mjs --tests   also bundle test/pure-entry.ts into .test-out/pure.mjs (the pure
//                                    modules the unit tests import directly)
//   node scripts/build.mjs --pack    also write oxp3deck-<version>.bpk (gzip ustar of dist/), for a
//                                    developer-mode install
//   node scripts/build.mjs --clean   delete dist/, .test-out/ and *.bpk
//
// The esbuild options are those of packages/plugin-cli/src/bundle.ts (not minified, deterministic,
// JSX through @bathysphere/sdk), and the bundle gets the same checks: no import, export-from,
// import() or require, and a warning for globals the runtime lacks. The SDK is bundled from its
// sources in the Bathysphere checkout .bathysphere points at (scripts/link.mjs).
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { linkBathysphere } from "./link.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The SDK, esbuild and acorn come from the Bathysphere checkout that .bathysphere points at
// (--clean needs none).
const cleanOnly = process.argv.includes("--clean");
const bathysphere = cleanOnly ? root : linkBathysphere();
const requireFromCheckout = createRequire(join(bathysphere, "package.json"));
const { parse } = cleanOnly ? {} : requireFromCheckout("acorn");
const { build } = cleanOnly ? {} : requireFromCheckout("esbuild");
const sdk = join(bathysphere, "packages", "sdk", "src");
const dist = join(root, "dist");
const testOut = join(root, ".test-out");
const args = new Set(process.argv.slice(2));
/** SPEC §5.2 caps a line at 1 MiB and hostd loads main.js whole; stay far below. */
const MAX_MAIN_BYTES = 1024 * 1024;
/** SPEC §3.1: assets at most 20 MiB in total. */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const alias = {
  "@bathysphere/sdk": join(sdk, "index.ts"),
  "@bathysphere/sdk/jsx-runtime": join(sdk, "jsx-runtime.ts"),
  "@bathysphere/sdk/jsx-dev-runtime": join(sdk, "jsx-dev-runtime.ts"),
};

if (args.has("--clean")) {
  rmSync(dist, { recursive: true, force: true });
  rmSync(testOut, { recursive: true, force: true });
  for (const f of readdirSync(root)) if (f.endsWith(".bpk")) rmSync(join(root, f));
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

/** Globals the runtime does not provide (SPEC §5.2); referencing one is a warning. */
const UNAVAILABLE = new Set(["process", "Buffer", "require", "module", "exports", "__dirname", "__filename", "global", "window", "document", "navigator", "location", "fetch", "Intl", "WebAssembly", "setImmediate"]);

/** The checks of plugin-cli's checkBundle: errors for anything a module loader would be needed for. */
function checkBundle(code) {
  const errors = [];
  const warnings = new Set();
  const program = parse(code, { ecmaVersion: 2023, sourceType: "module", locations: true });
  const declared = new Set();
  const refs = [];
  const bind = (p) => {
    if (!p) return;
    if (p.type === "Identifier") declared.add(p.name);
    else if (p.type === "ObjectPattern") for (const prop of p.properties) bind(prop.type === "RestElement" ? prop.argument : prop.value);
    else if (p.type === "ArrayPattern") for (const el of p.elements) bind(el);
    else if (p.type === "RestElement") bind(p.argument);
    else if (p.type === "AssignmentPattern") bind(p.left);
  };
  const visit = (n, parent, key) => {
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        errors.push(`line ${n.loc.start.line}: the bundle imports a module`);
        break;
      case "ExportNamedDeclaration":
        if (n.source) errors.push(`line ${n.loc.start.line}: the bundle re-exports from a module`);
        break;
      case "ImportExpression":
        errors.push(`line ${n.loc.start.line}: the bundle uses import()`);
        break;
      case "VariableDeclarator":
        bind(n.id);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (n.id) bind(n.id);
        for (const p of n.params) bind(p);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (n.id) bind(n.id);
        break;
      case "CatchClause":
        bind(n.param);
        break;
      case "Identifier": {
        const isProp = parent && ((parent.type === "MemberExpression" && key === "property" && !parent.computed) || ((parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") && key === "key" && !parent.computed));
        const isLabel = parent && (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement");
        const guarded = parent?.type === "UnaryExpression" && parent.operator === "typeof";
        if (!isProp && !isLabel && !guarded) refs.push({ name: n.name, line: n.loc.start.line });
        break;
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "loc" || k === "start" || k === "end") continue;
      if (Array.isArray(v)) {
        for (const x of v) if (x && typeof x.type === "string") visit(x, n, k);
      } else if (v && typeof v === "object" && typeof v.type === "string") visit(v, n, k);
    }
  };
  visit(program, undefined, undefined);
  if (/\bDynamic require of "/.test(code)) errors.push("the bundle calls require() on a module esbuild could not bundle");
  for (const r of refs) {
    if (UNAVAILABLE.has(r.name) && !declared.has(r.name)) warnings.add(`line ${r.line}: "${r.name}" does not exist in the Bathysphere runtime`);
  }
  return { errors, warnings: [...warnings] };
}

const common = {
  bundle: true,
  write: false,
  jsx: "automatic",
  jsxImportSource: "@bathysphere/sdk",
  charset: "utf8",
  treeShaking: true,
  minify: false,
  alias,
  logLevel: "warning",
};

async function bundleMain() {
  const result = await build({
    ...common,
    entryPoints: [join(root, "src", "main.tsx")],
    absWorkingDir: root,
    outfile: join(dist, "main.js"),
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["module"],
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
    splitting: false,
    sourcemap: false,
    banner: { js: "// SPDX-FileCopyrightText: 2026 Featherwolf\n// SPDX-License-Identifier: MIT\n// OXP3 Deck for Bathysphere. Bundles @bathysphere/sdk (MIT)." },
  });
  const out = result.outputFiles[0];
  const { errors, warnings } = checkBundle(out.text);
  for (const w of warnings) console.warn(`warning: main.js ${w}`);
  if (errors.length) throw new Error(`main.js is not a valid Bathysphere module:\n  ${errors.join("\n  ")}`);
  if (out.contents.length > MAX_MAIN_BYTES) throw new Error(`main.js is ${out.contents.length} bytes; this build allows ${MAX_MAIN_BYTES}`);
  return out.contents;
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function writeDist(main) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "main.js"), main);
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  let assetBytes = 0;
  for (const f of filesUnder(join(root, "assets"))) {
    const rel = relative(root, f);
    if (!/^assets\/[A-Za-z0-9._-]+$/.test(rel)) throw new Error(`unexpected asset path ${rel}`);
    if (rel.endsWith(".json")) JSON.parse(readFileSync(f, "utf8")); // a broken asset fails the build, not the device
    assetBytes += statSync(f).size;
    copyFileSync(f, join(dist, rel));
  }
  if (assetBytes > MAX_ASSET_BYTES) throw new Error(`assets are ${assetBytes} bytes; SPEC §3.1 allows ${MAX_ASSET_BYTES}`);
  for (const f of ["README.md", "LICENSE", "CHANGELOG.md"]) copyFileSync(join(root, f), join(dist, f));
}

/** A deterministic gzip-compressed ustar of dist/ (SPEC §3.1): regular files only, sorted, mtime 0. */
function pack() {
  const blocks = [];
  const header = (name, size) => {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, "ascii");
    h.write("0000000\0", 108, "ascii");
    h.write("0000000\0", 116, "ascii");
    h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    h.write("00000000000\0", 136, "ascii");
    h.write("        ", 148, "ascii");
    h.write("0", 156, "ascii");
    h.write("ustar\0", 257, "ascii");
    h.write("00", 263, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return h;
  };
  for (const file of filesUnder(dist)) {
    const name = relative(dist, file).split("\\").join("/");
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.length > 100) throw new Error(`cannot pack ${name}`);
    const data = readFileSync(file);
    blocks.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  const out = join(root, `oxp3deck-${manifest.version}.bpk`);
  writeFileSync(out, gzipSync(Buffer.concat(blocks), { level: 9 }));
  return out;
}

/** The pure modules (no host calls at import time) as one node module for the unit tests. */
async function bundleTests() {
  rmSync(testOut, { recursive: true, force: true });
  const result = await build({
    ...common,
    entryPoints: [join(root, "test", "pure-entry.ts")],
    outfile: join(testOut, "pure.mjs"),
    format: "esm",
    platform: "node",
    target: "node22",
    banner: { js: "// SPDX-FileCopyrightText: 2026 Featherwolf\n// SPDX-License-Identifier: MIT" },
  });
  mkdirSync(testOut, { recursive: true });
  writeFileSync(join(testOut, "pure.mjs"), result.outputFiles[0].contents);
}

const main = await bundleMain();
writeDist(main);
console.log(`dist/main.js: ${(main.length / 1024).toFixed(1)} KiB`);
if (args.has("--pack")) console.log(`packed ${relative(root, pack())}`);
if (args.has("--tests")) {
  await bundleTests();
  console.log("bundled the pure modules into .test-out/pure.mjs");
}
