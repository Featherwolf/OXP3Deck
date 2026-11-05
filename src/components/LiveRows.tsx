// The live readouts (DESIGN.md "Live readouts"): one "Live" row in the quick panel, a "Live readouts" section on the
// Power tab. Read every second, only while the panel or tab shows (store.ts useLive).
import { PanelSection, PanelSectionRow } from "@decky/ui";
import { FC } from "react";

import { LIVE_SOURCES, liveLine, liveRows } from "../live";
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

/** The quick panel's "Live" row (also while power control is off). */
export const LiveRow: FC<{ active: boolean }> = ({ active }) => {
  const { live, error } = useLive(active);
  return (
    <PanelSectionRow>
      <Status ok={null} label="Live" detail={error ? "Couldn't read." : liveLine(live)} details={liveDetails(live)} />
      <Problem what="Live" error={error} />
    </PanelSectionRow>
  );
};

/** The Power tab's "Live readouts": one value per row. */
export const LiveSection: FC<{ active: boolean }> = ({ active }) => {
  const shown = usePageVisible();      // the tab can stay mounted behind a game: no reads (they wake the GPU) then
  const { live, error } = useLive(active && shown);
  const rows = liveRows(live);
  const d = liveDetails(live);
  return (
    <PanelSection title="Live readouts">
      <PanelSectionRow>
        {!live && !error && <Status ok={null} label="Reading…" />}
        {rows.map((r) => <Status key={r.label} ok={null} label={r.label} detail={r.value} details={{ ...d, title: r.label }} />)}
        <Problem what="Live readouts" error={error} />
      </PanelSectionRow>
    </PanelSection>
  );
};
