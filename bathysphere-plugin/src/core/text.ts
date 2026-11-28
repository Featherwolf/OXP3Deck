// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The one-line rule (original src/text.ts): every row shows one short plain line up front and the
 * rest goes into its Details. Lengths count Unicode scalar values, as the host does ([...s].length),
 * and Details respect the host dialog limits (SPEC §5.3: title ≤ 80 chars, body ≤ 4 KiB, ≤ 32 lines
 * of ≤ 200 chars).
 */
import { isFormatChar, type Details } from "@bathysphere/sdk";

/** The longest one-liner a row shows up front. */
export const MAX_LINE = 80;

const BODY_BYTES = 4096;
const encoder = new TextEncoder();

const squash = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/** `s` cut to at most `max` scalar values, at a word when one is near, with "…". */
export function fit(s: string | null | undefined, max: number = MAX_LINE): string {
  const cps = [...squash(s)];
  if (cps.length <= max) return cps.join("");
  const room = cps.slice(0, Math.max(1, max - 1)).join("");
  const sp = room.lastIndexOf(" ");
  return `${(sp > room.length / 2 ? room.slice(0, sp) : room).replace(/[\s,.;:·-]+$/, "")}…`;
}

/**
 * The first sentence of `s`: up to the first ". " or ": " after 20 characters when that fits in
 * `max`; else `s` itself when it fits; else `s` cut at a word.
 */
export function firstSentence(s: string | null | undefined, max: number = MAX_LINE): string {
  const t = squash(s);
  if (!t) return "";
  const re = /[.:](\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if ([...t.slice(0, m.index)].length < 20) continue;
    const cut = t[m.index] === ":" ? t.slice(0, m.index) : t.slice(0, m.index + 1);
    if ([...cut].length <= max) return cut;
    break;
  }
  return fit(t, max);
}

/** True when the first sentence is the whole text, so Details would only repeat it. */
export const fitsOneLine = (s: string | null | undefined, max: number = MAX_LINE): boolean => firstSentence(s, max) === squash(s);

/** `s` cut to at most `bytes` UTF-8 bytes on a scalar-value boundary. */
export function clipBytes(s: string, bytes: number): string {
  if (encoder.encode(s).length <= bytes) return s;
  let used = 0;
  let out = "";
  for (const cp of s) {
    const n = encoder.encode(cp).length;
    if (used + n > bytes - 3) break;
    used += n;
    out += cp;
  }
  return `${out}…`;
}

/** The last `bytes` UTF-8 bytes of `s` on a scalar-value boundary, with "…" in front when cut. */
export function tailBytes(s: string, bytes: number): string {
  if (encoder.encode(s).length <= bytes) return s;
  const cps = [...s];
  let used = 0;
  let i = cps.length;
  while (i > 0) {
    const n = encoder.encode(cps[i - 1]!).length;
    if (used + n > bytes - 3) break;
    used += n;
    i--;
  }
  return `…${cps.slice(i).join("")}`;
}

/** Control characters other than LF and TAB, format characters, and the line and paragraph separators. */
const hidden = (c: string): boolean => {
  const cp = c.codePointAt(0)!;
  return ((cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) && cp !== 0x0a && cp !== 0x09) || isFormatChar(cp) || cp === 0x2028 || cp === 0x2029;
};

/** True when `s` may sit in a `code` node with Copy: no control (other than LF and TAB) or format character (SPEC §6.2). */
export const copySafe = (s: string): boolean => ![...s].some(hidden);

/** A log's text for Details: LF and TAB kept, every other control and format character dropped, the end kept. */
export function logTail(s: string, bytes: number): string {
  return tailBytes([...s.replace(/\r\n/g, "\n")].filter((c) => !hidden(c)).join(""), bytes);
}

/** A dialog title (SPEC §5.3: 1–80 characters) around a name that may be long: the name is cut to fit. */
export function dialogTitle(before: string, name: string, after = ""): string {
  return `${before}${fit(name, Math.max(1, MAX_LINE - [...before].length - [...after].length))}${after}`;
}

/** A Details dialog within the host's limits: paragraphs joined by blank lines, long text cut. */
export function details(title: string, body: string | readonly (string | null | undefined | false)[], lines?: readonly string[]): Details {
  const text = typeof body === "string" ? body : body.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n");
  const out: Details = { title: fit(title, 80) || "Details", body: clipBytes(text || title, BODY_BYTES) };
  const ls = (lines ?? []).filter((l) => l !== "").slice(0, 32).map((l) => fit(l, 200));
  if (ls.length) out.lines = ls;
  return out;
}

/** "a", "a and b", "a, b and c". */
export function andList(xs: readonly string[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "1.5 W", "17 W". */
export const watts = (w: number | null | undefined): string => (w == null ? "?" : `${Math.round(w * 10) / 10} W`);

/** "3 h 10 min" / "45 min". */
export function minutesText(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m) || m < 0) return null;
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const min = total % 60;
  return h ? `${h} h ${min} min` : `${min} min`;
}
