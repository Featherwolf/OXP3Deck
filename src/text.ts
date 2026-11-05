// The one-line rule (DESIGN.md "Rules", "Frontend → Details"): every row shows one short plain line; the rest goes
// in its Details. Framework-free so node can test it (tests/js/text.test.mjs).

/** The longest one-liner a row should show up front. */
export const MAX_LINE = 80;

/**
 * The first sentence of `s`, for a row that shows only that (the whole text goes in its Details): up to the first
 * ". " or ": " after 20 characters; else, when longer than `max`, cut at a word before `max` with "…".
 */
export const firstSentence = (s: string | null | undefined, max: number = MAX_LINE): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const re = /[.:](\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index < 20) continue;
    const end = m.index + 1;
    const cut = t[m.index] === ":" ? t.slice(0, m.index) : t.slice(0, end);
    if (cut.length <= max) return cut;
    break;
  }
  if (t.length <= max) return t;
  const room = t.slice(0, Math.max(1, max - 1));
  const sp = room.lastIndexOf(" ");
  return `${(sp > max / 2 ? room.slice(0, sp) : room).replace(/[\s,;:.]+$/, "")}…`;
};

/** True when `s` is the whole text, so a Details window would only repeat it. */
export const fitsOneLine = (s: string | null | undefined, max: number = MAX_LINE): boolean =>
  firstSentence(s, max) === (s ?? "").replace(/\s+/g, " ").trim();
