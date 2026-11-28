// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Rows every surface uses: a status line with Details, a problem with Retry and the full error to
 * copy, text to copy, a "Run this yourself" card with the exact line next to it, and the error
 * boundary each section renders in (original Hint.tsx, Boundary.tsx). Lines follow the one-line rule.
 */
import { Button, Callout, Code, Instructions, ListItem, log, type Element, type HostError, type Tone } from "@bathysphere/sdk";
import { explain, type Explained } from "../core/errors";
import { copySafe, details, firstSentence, fit, fitsOneLine } from "../core/text";

/** A status row: label, one line, a tone, and the longer text behind Details. */
export function Status(p: { label: string; line?: string | null; tone?: Tone; more?: string | readonly (string | null | false | undefined)[]; lines?: string[]; onClick?: () => void | Promise<void>; actionLabel?: string }): Element {
  const line = p.line ? firstSentence(p.line) : "";
  const more = (typeof p.more === "string" ? [p.more] : (p.more ?? [])).filter((x): x is string => !!x);
  const needDetails = more.length > 0 || (!!p.line && !fitsOneLine(p.line)) || (p.lines?.length ?? 0) > 0;
  return (
    <ListItem
      label={fit(p.label, 80) || "Status"}
      {...(line ? { description: line } : {})}
      {...(p.tone ? { tone: p.tone } : {})}
      {...(needDetails ? { details: details(p.label, [p.line, ...more], p.lines) } : {})}
      {...(p.onClick ? { onClick: p.onClick } : {})}
      {...(p.actionLabel ? { actionLabel: p.actionLabel } : {})}
    />
  );
}

/** An error under a control: one line, the host's message behind Details. */
export function ErrorRow(p: { label?: string; error: Explained | null | undefined }): Element | null {
  if (!p.error) return null;
  return <Status label={p.label ?? p.error.line} line={p.label ? p.error.line : null} tone={p.error.tone} more={[p.error.message, `Code: ${p.error.code}`]} />;
}

/**
 * Text to copy (a command line, launch options, an error). A `code` node with Copy may not hold
 * control or format characters (SPEC §6.2): such text is shown without Copy, with a row saying why.
 */
export function CopyCode(p: { text: string }): Element {
  if (copySafe(p.text)) return <Code text={p.text} />;
  return (
    <>
      <Status label="Invisible characters" line="This text holds characters that would not paste as shown, so Copy is off." tone="warn" more="A control or format character (a carriage return, a zero-width space) is in it. Fix it where it comes from, then copy it." />
      <Code text={p.text} copy={false} />
    </>
  );
}

/** A problem that a retry may fix: a red callout, Retry, and the full error to copy. */
export function Problem(p: { title: string; error: Explained; onRetry?: () => void | Promise<void> }): Element {
  return (
    <>
      <Callout title={firstSentence(p.title, 80)} tone="bad" text={p.error.line} />
      {p.onRetry ? <Button label="Retry" icon="refresh" onClick={p.onRetry} /> : null}
      <CopyCode text={`${p.error.code}: ${p.error.message}`} />
    </>
  );
}

/** What a view shows while a shared read has no value: "Reading…", or its error with Retry. */
export function Unread(p: { what: string; error: HostError | undefined; onRetry: () => void }): Element {
  return p.error ? <Problem title={`${p.what}: not read`} error={explain(p.error)} onRetry={p.onRetry} /> : <Status label="Reading…" />;
}

/** A "Run this yourself" card (manifest contributes.instructions), optionally with the exact line beside it. */
export function Card(p: { id: string; steps?: number[]; code?: string | null }): Element {
  return (
    <>
      <Instructions id={p.id} {...(p.steps ? { steps: p.steps } : {})} />
      {p.code ? <CopyCode text={p.code} /> : null}
    </>
  );
}

/**
 * Renders one section; a bug in it draws a red callout with the error to copy instead, and the rest
 * of the surface still renders (the host's error card stays the last resort).
 */
export async function safeSection(name: string, render: () => Element | null | Promise<Element | null>): Promise<Element | null> {
  try {
    return await render();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    log.error(`section ${name}: ${err.message}`);
    return (
      <>
        <Callout title={`${name}: this section hit an error`} tone="bad" text={firstSentence(err.message) || "Unknown error"} />
        <CopyCode text={`${err.message}\n${(err.stack ?? "").split("\n").slice(0, 12).join("\n")}`} />
      </>
    );
  }
}
