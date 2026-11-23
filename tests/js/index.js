// Lets `node --test tests/js` (pnpm test:js) run every *.test.mjs here: given a folder, node loads the folder's
// index.js as one test file instead of looking inside it. Not a test itself (no .test.mjs).
import { readdirSync } from "node:fs";

const here = new URL("./", import.meta.url);
for (const name of readdirSync(here).filter((n) => n.endsWith(".test.mjs")).sort()) {
  await import(new URL(name, here).href);
}
