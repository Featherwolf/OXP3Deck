// The live readouts (DESIGN.md "Live readouts", "Quick Access groups"): the quick panel's Live group (its closed
// header shows liveLine) and the Power tab's "Live readouts" section. Read every second, only while the panel or tab
// shows (store.ts useLive).
import { PanelSection, PanelSectionRow } from "@decky/ui";
import { FC } from "react";

import { LIVE_SOURCES, liveRows } from "../live";
import { useLive, usePageVisible } from "../store";
import type { Live } from "../types";
import { DetailsSpec, paragraphs } from "./confirm";
import { Problem, Status } from "./Hint";

const liveDetails = (live: Live | null): DetailsSpec => ({
  title: "Live",
  body: paragraphs([
    ...liveRows(live).map((r) => `${r.label}: ${r.value}.`),
    "Read every second while this panel is open; nothing is read while it is closed.",
  ]),
  lines: LIVE_SOURCES,
});

/** One row per readout (the quick panel's Live group and the Power tab's "Live readouts"), from one sample. */
export const LiveRows: FC<{ live: Live | null; error: string | null; what?: string }> = ({ live, error, what = "Live" }) => {
  const rows = liveRows(live);
  const d = liveDetails(live);
  return (
    <PanelSectionRow>
      {!live && !error && <Status ok={null} label="Reading…" />}
      {rows.map((r) => <Status key={r.label} ok={null} label={r.label} detail={r.value} details={{ ...d, title: r.label }} />)}
      <Problem what={what} error={error} />
    </PanelSectionRow>
  );
};

/** The Power tab's "Live readouts": one value per row. */
export const LiveSection: FC<{ active: boolean }> = ({ active }) => {
  const shown = usePageVisible();      // the tab can stay mounted behind a game: no reads (they wake the GPU) then
  const { live, error } = useLive(active && shown);
  return (
    <PanelSection title="Live readouts">
      <LiveRows live={live} error={error} what="Live readouts" />
    </PanelSection>
  );
};
