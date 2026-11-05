// "Copy launch options" (DESIGN.md "Copy launch options"): when OXP3 Deck cannot write a game's launch options itself
// (or the user just wants them), the whole line and a Copy button; when no clipboard method works, the line in a text
// field to copy with Steam's keyboard. The line and texts are copyopts.ts's; the clipboard chain is clipboard.ts's.
import { ButtonItem, TextField } from "@decky/ui";
import { FC, useEffect, useState } from "react";

import { copyText } from "../clipboard";
import { CopyInput, copyDetails, copyLine, copyRow } from "../copyopts";
import { EFFECTS } from "../effects";
import { toast } from "../util";
import { DetailsSpec, paragraphs } from "./confirm";
import { Code, explain, explainWhen, INFO, WithDetails } from "./Hint";

export const CopyLaunchRows: FC<{ input: CopyInput; game: string }> = ({ input, game }) => {
  const c = copyLine(input);
  const [manual, setManual] = useState<string | null>(null);   // the line shown to copy by hand (all methods failed)
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (manual !== null && manual !== c?.line) setManual(null); }, [c?.line]);
  if (!c) return null;
  const row = copyRow(c);
  const d: DetailsSpec = {
    title: row.label,
    body: <>{paragraphs(copyDetails(c, game))}<br /><Code>{c.line}</Code></>,
    lines: c.adds ? [c.adds] : undefined, linesTitle: "Adds to launch options:",
  };
  const copy = async (e?: MouseEvent) => {
    setBusy(true);
    const how = await copyText(c.line, (e?.currentTarget ?? e?.target ?? null) as { ownerDocument?: unknown } | null);
    setBusy(false);
    if (how) { setManual(null); toast(`Paste it into ${game}'s Properties → Launch options.`, "Copied"); }
    else setManual(c.line);
  };
  return (
    <>
      <WithDetails details={d}>
        <ButtonItem layout="below" disabled={busy} onClick={copy}
          description={explainWhen(row.line, EFFECTS["game.copy"])}>
          {busy ? "Copying…" : `${row.label}${INFO}`}
        </ButtonItem>
      </WithDetails>
      {manual !== null && (
        <TextField label="Launch options" value={manual} bShowCopyAction
          onChange={() => setManual(c.line)}
          description={explain("Couldn't copy. Select the line and copy it with Steam's keyboard.")} />
      )}
    </>
  );
};
