// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// Based on ClawDeck's FullPage (src/pages.tsx): the full page.
// One tab per area, navigated with the D-pad on the left like Steam's own settings. Each tab's content is inside a
// Boundary (components/Boundary.tsx): a render error shows a red row with Retry in that tab only.
import { SidebarNavigation } from "@decky/ui";
import { FC, useEffect } from "react";
import { MdBolt, MdBuild, MdGamepad, MdHistory, MdMemory, MdSportsEsports, MdAutoAwesome } from "react-icons/md";

import { get_overview, oxp3_status } from "../backend";
import { Boundary } from "../components/Boundary";
import { ROUTE } from "../nav";
import { syncJob, useCurrentJob, useResource } from "../store";
import type { Overview, StatusRes } from "../types";
import { ButtonsTab } from "./Buttons";
import { FixesTab } from "./Fixes";
import { GamesTab } from "./Games";
import { KernelTab } from "./Kernel";
import { PowerTab } from "./Power";
import { oxp3Usable } from "./Quick";
import { UpdatesTab } from "./Updates";
import { XessTab } from "./XeSS";

export const FullPage: FC = () => {
  const ov = useResource<Overview>("overview", get_overview, { fresh: true });
  const job = useCurrentJob();
  useEffect(() => { if (ov.data?.ok) syncJob(ov.data.job); }, [ov.data]);
  const st = useResource<StatusRes>("status", oxp3_status, { skip: !oxp3Usable(ov.data?.oxp3) || job?.state === "running" });
  const s = st.data?.ok ? st.data.status : null;
  // oxp3-tool kernel works only on CachyOS booting with Limine (kernel_cmd.py)
  const limine = s?.os.platform === "cachyos" && s.boot === "Limine";
  return (
    <SidebarNavigation title="OXP3 Deck" showTitle pages={[
      { title: "Power", icon: <MdBolt />, route: `${ROUTE}/power`, content: <PowerTab /> },
      { title: "Fixes", icon: <MdBuild />, route: `${ROUTE}/fixes`, content: <FixesTab /> },
      { title: "Buttons", icon: <MdGamepad />, route: `${ROUTE}/buttons`, content: <ButtonsTab /> },
      { title: "XeSS", icon: <MdAutoAwesome />, route: `${ROUTE}/xess`, content: <XessTab /> },
      { title: "Games", icon: <MdSportsEsports />, route: `${ROUTE}/games`, content: <GamesTab /> },
      { title: "Kernel", icon: <MdMemory />, route: `${ROUTE}/kernel`, content: <KernelTab />, visible: limine },
      { title: "Updates & logs", icon: <MdHistory />, route: `${ROUTE}/updates`, content: <UpdatesTab /> },
    ].map((p) => ({ ...p, content: <Boundary key={p.route} what={p.title} wrap="section">{p.content}</Boundary> }))} />
  );
};

/** The route: the page inside a Boundary too (a render error in the sidebar itself). */
export const FullPageRoute: FC = () => <Boundary what="All settings" wrap="section"><FullPage /></Boundary>;
