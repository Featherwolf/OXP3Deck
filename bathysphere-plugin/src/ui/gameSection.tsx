// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/** The section on each game's page: its XeSS launch options, automatic setup, files, advice and power profile. */
import { Panel, type Element, type GamePageSectionContext } from "@bathysphere/sdk";
import { fit } from "../core/text";
import { runPass } from "../games/autosetup";
import { isRunning } from "../games/running";
import { draftRows, gameControls } from "./game";
import { safeSection } from "./rows";
import { loadBase } from "./view";

/** Games whose section opened this session: the automatic setup runs once for each (original: on opening its controls). */
const passed = new Set<number>();

export async function renderGameSection(ctx: GamePageSectionContext): Promise<Element> {
  await loadBase(false);
  const title = `OXP3 Deck: ${fit(ctx.name, 50)}`;
  // Bathysphere never changes a shortcut's launch options: the same choices, as a line to paste
  if (ctx.isShortcut) return <Panel title={title}>{draftRows(ctx.appid, ctx.name, "shortcut")}</Panel>;
  if (!passed.has(ctx.appid) && !isRunning(ctx.appid)) {
    passed.add(ctx.appid);
    void runPass(ctx.appid, ctx.name, isRunning).then(() => ctx.refresh());
  }
  const body = await safeSection("This game", async () => <>{await gameControls(ctx.appid, ctx.name, true)}</>);
  return <Panel title={title}>{body}</Panel>;
}
