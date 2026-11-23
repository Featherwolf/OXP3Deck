// Error boundaries and Problem rows (ROADMAP N-3): the texts the "This section hit an error" row shows and the
// texts "Copy" puts on the clipboard. Framework-free (tests/js/boundary.test.mjs).
import { firstSentence } from "./text";

/** The line a section that failed to render shows instead of its rows. */
export const CRASH_LABEL = "This section hit an error";

/** An error's message, whatever was thrown (an Error, a string, anything else). */
export const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message || e.name || "unknown error";
  if (typeof e === "string") return e || "unknown error";
  try {
    const s = JSON.stringify(e);
    return s && s !== "{}" ? s : String(e);
  } catch {
    return String(e);
  }
};

/** The one line under the crash label: the message's first sentence. */
export const crashLine = (e: unknown): string => firstSentence(errorMessage(e), 100);

const trimStack = (s: string | null | undefined, max = 12): string[] =>
  (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, max);

/**
 * What "Copy details" copies for a section that failed to render: where, the message, then the first lines of the
 * error's stack and React's component stack.
 */
export const crashText = (what: string, e: unknown, componentStack?: string | null): string => {
  const stack = e instanceof Error ? trimStack(e.stack).filter((l) => l !== errorMessage(e) && !l.endsWith(`: ${errorMessage(e)}`)) : [];
  const comp = trimStack(componentStack, 8);
  return [
    `OXP3 Deck: ${what}: ${CRASH_LABEL.toLowerCase()}`,
    errorMessage(e),
    ...(stack.length ? ["", "Stack:", ...stack] : []),
    ...(comp.length ? ["", "Components:", ...comp] : []),
  ].join("\n");
};

/** What a Problem row's Copy copies: its title and the whole error. */
export const problemText = (what: string | null | undefined, error: string): string =>
  `${what ? `${what}: did not work` : "Did not work"}\n${error.trim()}`;
