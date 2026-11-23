// Damaged or newer settings files (ROADMAP T1-5, src/files.ts): one red row each in the Status section, with its
// Details, the error of the last tap, and Start fresh (asks first) or OK.
import { DialogButton, PanelSectionRow } from "@decky/ui";
import { FC } from "react";

import { useAction } from "../actions";
import { file_fresh } from "../backend";
import { EFFECTS } from "../effects";
import { fileRow } from "../files";
import { invalidate } from "../store";
import type { FileProblem } from "../types";
import { confirm, paragraphs } from "./confirm";
import { Problem, Status } from "./Hint";

const FileRow: FC<{ p: FileProblem }> = ({ p }) => {
  const act = useAction();
  const r = fileRow(p);
  const tap = () => act.run(r.button, async () => {
    if (r.ask && !(await confirm({ title: r.ask.title, text: r.ask.text, ok: r.ask.ok, destructive: true,
      effect: EFFECTS["settings.fresh"] }))) return null;
    const res = await file_fresh(p.file);
    invalidate("overview");
    invalidate("auto:");
    invalidate("opti-info:");
    invalidate("game:");
    return res.ok ? null : res.error;
  });
  return (
    <PanelSectionRow>
      <Status ok={false} red={p.kind !== "reset"} label={r.label} detail={r.line}
        details={{ title: r.details.title, body: paragraphs(r.details.body), lines: r.details.lines, linesTitle: "Technical:" }} />
      <DialogButton disabled={!!act.busy} onClick={tap} style={{ padding: "6px 2px", margin: "2px 0 6px" }}>
        {act.busy ? "Working…" : r.button}
      </DialogButton>
      <Problem what={r.button} error={act.error} onRetry={act.retry} />
    </PanelSectionRow>
  );
};

/** The rows for the overview's `files` (nothing when there are none). */
export const FileRows: FC<{ files: FileProblem[] | null | undefined }> = ({ files }) => (
  <>{(files ?? []).map((p) => <FileRow key={p.file} p={p} />)}</>
);
