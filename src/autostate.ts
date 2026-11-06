// The automatic setup's state in the frontend (DESIGN.md "Automatic setup (0.6)"): the backend's auto_state answer in
// the store's cache, a game record from any answer put into it, and markManual. Its own file so OptiControls can mark
// a game Manual without importing AutoSetup.tsx (which imports OptiControls).
import { auto_mode, auto_state } from "./backend";
import { isSteamApp } from "./steam";
import { invalidate, load, peek, put, useResource } from "./store";
import type { AutoGame, AutoStateRes } from "./types";

export const STATE_KEY = "auto:state";
export const planKey = (appid: string) => `auto:plan:${appid}`;
export const useAutoState = () => useResource<AutoStateRes>(STATE_KEY, auto_state);

export const stateNow = async (): Promise<AutoStateRes | undefined> => peek<AutoStateRes>(STATE_KEY) ?? load(STATE_KEY, auto_state);

/** A game record from any answer into the cached state, so every row shows it. */
export const noteGame = (g: AutoGame | null | undefined) => {
  if (!g || !g.appid) return;
  const cur = peek<AutoStateRes>(STATE_KEY);
  if (cur?.ok) put<AutoStateRes>(STATE_KEY, { ...cur, games: { ...cur.games, [g.appid]: g } });
};

/** The switch is on and the game is Automatic (Copy launch options: "added when you quit the game"). */
export const autoOnFor = (st: AutoStateRes | undefined, appid: string): boolean =>
  !!st?.ok && st.on && st.games?.[appid]?.mode !== "manual";

/**
 * Mark a game Manual after a change the user made by hand (GameControls' write, OptiControls' install / update /
 * remove / choice, an Undo); a no-op while the switch is off or the game is Manual already.
 */
export const markManual = (appid: string, why: string): void => {
  if (!isSteamApp(appid)) return;
  void (async () => {
    const st = await stateNow();
    if (!st?.ok || !st.on || st.games?.[appid]?.mode === "manual") return;
    const r = await auto_mode(appid, "manual", why);
    if (r.ok) { noteGame(r.game); invalidate(planKey(appid)); }
  })().catch(() => undefined);
};
