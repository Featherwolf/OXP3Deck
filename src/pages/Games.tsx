// The running game, or the last one seen: the same XeSS options as the quick panel, with the full advice and the
// last run's details.
import { PanelSection, PanelSectionRow } from "@decky/ui";
import { FC } from "react";

import { GameControls } from "../components/GameControls";
import { Note, Status } from "../components/Hint";
import { lastGame, useRunningApp } from "../steam";

export const GamesTab: FC = () => {
  const app = useRunningApp();
  const game = app ?? lastGame();
  if (!game) {
    return (
      <PanelSection title="Games">
        <PanelSectionRow>
          <Note label="No game yet" details={{ title: "No game yet", body: "Start a game: this page then shows its XeSS settings (saved in its Steam launch options), how XeSS ran last time, and tips for its XeSS version. The last game stays here after it exits." }}>
            Start a game to see its XeSS settings here.</Note>
        </PanelSectionRow>
      </PanelSection>
    );
  }
  return (
    <PanelSection title="Game">
      <PanelSectionRow>
        <Status ok={null} label={game.name} detail="Changes apply next time you start it."
          details={{ title: game.name, body: app ? "Running now. Changes apply at its next start." : "Not running; the last game seen.", lines: [`Steam app id: ${game.appid}`] }} />
      </PanelSectionRow>
      <GameControls key={game.appid} app={game} running={!!app} />
    </PanelSection>
  );
};
