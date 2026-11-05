// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// The shared rows (DESIGN.md "Frontend → Details"): one plain line up front, the rest in a Details window that the
// Options (☰) button opens on any row that has one (A opens it too on a read-only row).
import { Field, Focusable } from "@decky/ui";
import { FC, ReactNode } from "react";

import { EffectSpec, effectText } from "../effects";
import { firstSentence } from "../text";
import { DetailsSpec, showDetails } from "./confirm";

export type { DetailsSpec };

/** The one-line description of a control: what it does, in plain words. Anything more goes in its Details. */
export const explain = (does: ReactNode): ReactNode => <span style={{ whiteSpace: "normal" }}>{does}</span>;

export const MUTED = "#9aa4b1";

/**
 * A setting's one line with its "When it takes effect" tag (DESIGN.md "When it takes effect"): `does`, then a muted
 * " · <tag>". `why` set: the control is greyed out, and the line says why instead (the tag stays).
 */
export const explainWhen = (does: ReactNode, effect: EffectSpec, why?: string | null): ReactNode => (
  <span style={{ whiteSpace: "normal" }}>{why || does}<span style={{ color: MUTED }}>{` · ${effectText(effect)}`}</span></span>
);

/** The mark a label carries when the row has Details. */
export const INFO = " ⓘ";

/** A control's or row's label: `text`, plus " ⓘ" when it has Details. */
export const label = (text: ReactNode, details?: DetailsSpec | null): ReactNode =>
  details ? <>{text}{INFO}</> : text;

/**
 * A control with Details: the Options (☰) button opens them while the control is focused (the footer says "Details"),
 * A still does the control's job. Gamepad events bubble up from the focused control to this Focusable.
 */
export const WithDetails: FC<{ details?: DetailsSpec | null; children: ReactNode }> = ({ details, children }) =>
  details ? (
    <Focusable onOptionsButton={() => showDetails(details)} onOptionsActionDescription="Details">{children}</Focusable>
  ) : <>{children}</>;

/** The props a read-only Field gets when it has Details: A and ☰ open them. */
const detailProps = (details?: DetailsSpec | null) => details ? {
  onActivate: () => showDetails(details),
  onOKActionDescription: "Details",
  onOptionsButton: () => showDetails(details),
  onOptionsActionDescription: "Details",
} : {};

const MARK = { ok: "✓", bad: "✗", info: "" };
export const RED = "#f44336";
const COLOR = { ok: "#4caf50", bad: RED, info: "#9aa4b1" };

/** A read-only status line the controller can land on: a ✓ / ✗ mark, a label and a one-line detail. */
export const Status: FC<{ ok: boolean | null; label: ReactNode; detail?: ReactNode; red?: boolean; details?: DetailsSpec | null }> =
  ({ ok, label: text, detail, red, details }) => {
    const k = ok === null ? "info" : ok ? "ok" : "bad";
    return (
      <Field focusable bottomSeparator="none" {...detailProps(details)}
        description={detail ? <span style={{ whiteSpace: "normal" }}>{detail}</span> : undefined}
        label={<span style={red ? { color: RED, fontWeight: "bold" } : undefined}>
          {MARK[k] && <span style={{ color: COLOR[k], marginRight: 8 }}>{MARK[k]}</span>}{label(text, details)}</span>} />
    );
  };

/**
 * The last action that did not work, in red under the control it belongs to: the error's first sentence, the whole
 * text in its Details.
 */
export const Problem: FC<{ error: string | null | undefined; what?: string; details?: DetailsSpec | null }> = ({ error, what, details }) => {
  if (!error) return null;
  const title = what ? `${what}: did not work` : "Did not work";
  const short = firstSentence(error, 100);
  const d = details ?? (short === error.trim() ? null : { title, body: <span style={{ wordBreak: "break-word" }}>{error}</span> });
  return <Status ok={false} red label={title} detail={short} details={d} />;
};

/** Plain information in one line, focusable so the D-pad scrolls through it; the longer text goes in `details`. */
export const Note: FC<{ children?: ReactNode; label?: ReactNode; details?: DetailsSpec | null }> = ({ children, label: text, details }) => (
  <Field focusable bottomSeparator="none" label={text !== undefined ? label(text, details) : undefined} {...detailProps(details)}
    description={children !== undefined && children !== null
      ? <span style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{children}{text === undefined && details ? INFO : ""}</span>
      : undefined} />
);

/** Text the user may have to type somewhere (launch options, paths): monospace, wraps anywhere. */
export const Code: FC<{ children: ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: "monospace", wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{children}</span>
);
