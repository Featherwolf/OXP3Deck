// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
import { definePlugin, routerHook } from "@decky/api";
import { DialogButton, Focusable, staticClasses } from "@decky/ui";
import { MdSettings, MdVideogameAsset } from "react-icons/md";

import { watchAutoSetup } from "./components/AutoSetup";
import { Boundary } from "./components/Boundary";
import { openPage, ROUTE } from "./nav";
import { FullPageRoute } from "./pages/Full";
import { QuickPanel } from "./pages/Quick";
import { onMainAppChange, runningApp } from "./steam";
import { clearPendingFor, flushPower, stopPolling, switchGame } from "./store";

export default definePlugin(() => {
  // exact: false, so /oxp3deck/<tab> reaches the page and SidebarNavigation picks the tab
  routerHook.addRoute(ROUTE, FullPageRoute, { exact: false });
  // power profiles follow the running game: the backend hears every change, and the game running at load, one call
  // at a time and only the newest waiting one (store.ts switchGame); a failure shows in the Power group
  const stopPower = onMainAppChange((a) => switchGame(a));
  switchGame(runningApp()?.appid ?? null);
  // a game that starts again has applied its "Restart the game" changes
  const stopPending = onMainAppChange((a) => clearPendingFor(a));
  // automatic setup: a few seconds after a game quits (never while it runs), the session events, the library scan
  const stopAuto = watchAutoSetup();
  return {
    name: "OXP3 Deck",
    // Decky's own title bar, with a button to the full page (as "More" at the bottom does)
    titleView: (
      <Focusable style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        <div className={staticClasses.Title}>OXP3 Deck</div>
        <DialogButton aria-label="All OXP3 Deck settings" onClick={() => openPage("fixes")}
          style={{ width: "auto", minWidth: 0, height: 28, padding: "0 10px", display: "flex", alignItems: "center" }}>
          <MdSettings />
        </DialogButton>
      </Focusable>
    ),
    content: <Boundary what="Quick Access panel" wrap="section"><QuickPanel /></Boundary>,
    icon: <MdVideogameAsset />,
    onDismount() {
      stopPower();
      stopPending();
      stopAuto();
      flushPower();
      stopPolling();
      try { routerHook.removeRoute(ROUTE); } catch { /* the loader is going away */ }
    },
  };
});
