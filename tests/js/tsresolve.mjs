// Lets node load src/*.ts files that import each other without the ".ts" extension (as the bundler and tsc do):
// imported by the node tests before they import such a file. Not a test itself (no .test.mjs).
import { register } from "node:module";

const hook = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith(".") && !/\\.[a-z]+$/i.test(specifier)) return next(specifier + ".ts", context);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);
