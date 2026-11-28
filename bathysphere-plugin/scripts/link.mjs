// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
//
// Points .bathysphere at a Bathysphere checkout. The build bundles @bathysphere/sdk from its sources
// there, uses its esbuild, acorn and TypeScript, and the tests run in its fake host
// (packages/fake-host, built) and, when it is built, its native runtime.
//
//   node scripts/link.mjs     create or update the link (run by build, typecheck and test)
//
// The checkout is BATHYSPHERE_DIR, or else a clone named Bathysphere or bathysphere next to this
// repository. Build the packages the plugin needs in it first:
//
//   npm ci && npm run build -w @bathysphere/sdk -w @bathysphere/fake-host
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");

/** The files the build and the tests read from the checkout. */
const NEEDED = [
  ["packages/sdk/src/index.ts", "a Bathysphere checkout"],
  ["node_modules/esbuild/package.json", "npm ci in the checkout"],
  ["packages/fake-host/dist/index.js", "npm run build -w @bathysphere/sdk -w @bathysphere/fake-host in the checkout"],
];

function findCheckout() {
  const candidates = process.env.BATHYSPHERE_DIR
    ? [resolve(process.env.BATHYSPHERE_DIR)]
    : [join(repo, "..", "Bathysphere"), join(repo, "..", "bathysphere")];
  for (const dir of candidates) if (existsSync(join(dir, NEEDED[0][0]))) return dir;
  const where = process.env.BATHYSPHERE_DIR ? `BATHYSPHERE_DIR (${candidates[0]})` : candidates.join(" or ");
  throw new Error(`no Bathysphere checkout at ${where}: clone https://github.com/Featherwolf/Bathysphere there or set BATHYSPHERE_DIR`);
}

export function linkBathysphere() {
  const target = findCheckout();
  const link = join(root, ".bathysphere");
  let current = null;
  try {
    if (lstatSync(link).isSymbolicLink()) current = resolve(root, readlinkSync(link));
    else throw new Error(`${link} exists and is not a link; remove it`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (current !== target) {
    if (current !== null) rmSync(link);
    symlinkSync(target, link, "dir");
  }
  for (const [file, how] of NEEDED.slice(1)) {
    if (!existsSync(join(link, file))) throw new Error(`${join(target, file)} is missing: run ${how}`);
  }
  return link;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`.bathysphere -> ${readlinkSync(linkBathysphere())}`);
  } catch (e) {
    console.error(`link: ${e.message}`);
    process.exit(1);
  }
}
