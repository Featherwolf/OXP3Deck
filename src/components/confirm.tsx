// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
import { ConfirmModal, showModal } from "@decky/ui";
import { ReactNode } from "react";

import { confirmLine, EffectSpec } from "../effects";

export type ConfirmOpts = {
  title: string;
  text?: ReactNode;          // what happens, and when it takes effect
  lines?: string[];          // e.g. oxp3-tool's dry-run plan
  linesTitle?: string;
  ok?: string;
  destructive?: boolean;
  effect?: EffectSpec;       // "Takes effect: …", after text (DESIGN.md "When it takes effect")
};

const Lines = ({ lines, title }: { lines: string[]; title: string }) => (
  <>
    <div style={{ marginTop: 12, fontWeight: "bold" }}>{title}</div>
    <div style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
      {lines.map((l, i) => <div key={i} style={{ wordBreak: "break-word" }}>{l}</div>)}
    </div>
  </>
);

/**
 * Ask before anything that changes the system. Resolves true only on OK; Cancel, B or closing the dialog any other
 * way gives false.
 */
export const confirm = (o: ConfirmOpts): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
  const body = (
    <div style={{ whiteSpace: "normal", maxHeight: "60vh", overflowY: "auto" }}>
      {o.text}
      {o.effect && <div style={{ marginTop: 8, fontWeight: "bold" }}>{confirmLine(o.effect)}</div>}
      {!!o.lines?.length && <Lines lines={o.lines} title={o.linesTitle ?? "Planned changes:"} />}
    </div>
  );
  try {
    const m = showModal(
      <ConfirmModal strTitle={o.title} strDescription={body} strOKButtonText={o.ok ?? "Continue"}
        strCancelButtonText="Cancel" bDestructiveWarning={o.destructive}
        onOK={() => done(true)} onCancel={() => done(false)} />,
    );
    // older Decky (3.2) has no ClosedPromise; there onCancel covers B and the close button
    m?.ClosedPromise?.then(() => done(false), () => done(false));
  } catch {
    done(false);
  }
});

/** What a row's Details window shows: the explanation, then the technical names as monospace lines. */
export type DetailsSpec = { title: string; body: ReactNode; lines?: string[]; linesTitle?: string };

/** A paragraph per string, for a Details body built from plain texts (conflicts.ts). */
export const paragraphs = (ps: (string | null | undefined | false)[]): ReactNode => (
  <>{ps.filter(Boolean).map((p, i) => <div key={i} style={{ marginTop: i ? 8 : 0 }}>{p}</div>)}</>
);

/**
 * The Details window of a row (DESIGN.md "Frontend → Details"): one "Close" button, a body that scrolls with the
 * D-pad. Steam Game Mode has no hover, so this replaces tooltips.
 */
export const showDetails = (d: DetailsSpec): void => {
  const body = (
    <div style={{ whiteSpace: "normal", maxHeight: "60vh", overflowY: "auto" }}>
      {d.body}
      {!!d.lines?.length && <Lines lines={d.lines} title={d.linesTitle ?? "Technical:"} />}
    </div>
  );
  try {
    showModal(<ConfirmModal bAlertDialog strTitle={d.title} strDescription={body} strOKButtonText="Close"
      onOK={() => undefined} onCancel={() => undefined} />);
  } catch { /* the modal root is gone while the plugin unloads */ }
};
