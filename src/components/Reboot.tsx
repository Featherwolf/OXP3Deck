// "Do not reboot" while oxp3-tool's boot-entry rebuild is unfinished, else "Reboot to finish" when a change waits
// for one (fix.pending from oxp3-tool status).
import { ButtonItem, PanelSectionRow } from "@decky/ui";
import { FC } from "react";

import { rebootNow, useAction } from "../actions";
import { useCurrentJob } from "../store";
import type { Overview, Oxp3Status } from "../types";
import { listText } from "../util";
import { EFFECTS } from "../effects";
import { explainWhen, label, Problem, Status, WithDetails } from "./Hint";

export const RebootRow: FC<{ o: Overview | null | undefined; st: Oxp3Status | null | undefined }> = ({ o, st }) => {
  const act = useAction();
  const job = useCurrentJob();
  const dnr = o?.do_not_reboot ?? st?.rebuild_unfinished ?? null;
  const waits = (st?.fixes ?? []).filter((f) => f.pending).map((f) =>
    f.pending === "inputplumber-restart" ? `${f.title} (the controller layout loads at the next reboot)` : f.title);
  const pending = !!(st?.reboot_pending ?? o?.reboot_pending) || waits.length > 0;
  if (dnr) {
    return (
      <PanelSectionRow>
        <Status ok={false} red label="Do not reboot yet"
          detail="A boot update didn't finish. Open Details before restarting."
          details={{
            title: "Do not reboot yet",
            body: "The fixes tool's last update of the boot entries did not finish (or still runs), so the device may not start. In Desktop Mode, open a terminal and run the command below; reboot only after it ends without errors.",
            lines: [`sudo ${dnr}`], linesTitle: "Run in a terminal:",
          }} />
      </PanelSectionRow>
    );
  }
  if (!pending) return null;
  const what = listText(waits) || "the last change";
  const details = { title: "Reboot to finish", body: `Waiting for a reboot: ${what}. Reboots right away after you confirm.` };
  return (
    <PanelSectionRow>
      <WithDetails details={details}>
        <ButtonItem layout="below" disabled={!!act.busy || job?.state === "running"}
          onClick={() => act.run("Reboot", () => rebootNow(`This finishes ${what}. Save your game first.`))}
          description={explainWhen("Some changes need a restart.", EFFECTS["reboot"], job?.state === "running" ? "Wait for the running task." : null)}>
          {act.busy ? "Rebooting…" : label("Reboot to finish", details)}
        </ButtonItem>
      </WithDetails>
      <Problem what="Reboot" error={act.error} />
    </PanelSectionRow>
  );
};
