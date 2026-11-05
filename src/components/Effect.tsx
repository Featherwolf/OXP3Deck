// The pending rows of "When it takes effect" (DESIGN.md): right under the control whose change waits for a game
// restart, a log-out or a reboot. The list lives in store.ts (notePending), in memory only.
import { FC } from "react";

import { pendingText } from "../effects";
import { usePending } from "../store";
import { Status } from "./Hint";

/** "Restart <game> to apply" / "Log out of Game Mode or reboot to apply" / "Reboot to apply", one per pending change. */
export const Pending: FC<{ ids: string[]; appid?: string | null }> = ({ ids, appid }) => {
  const list = usePending(ids, appid);
  const rows = new Map<string, { text: string; what: string[] }>();
  for (const p of list) {
    const text = pendingText(p.effect, p.game);
    if (!text) continue;
    const r = rows.get(text) ?? { text, what: [] };
    if (p.label) r.what.push(p.label);
    rows.set(text, r);
  }
  return (
    <>
      {[...rows.values()].map((r) => (
        <Status key={r.text} ok={null} label={r.text} detail={r.what.length ? `Changed: ${r.what.join(", ")}` : undefined}
          details={{ title: r.text, body: `${r.what.length ? `${r.what.join(", ")} changed. ` : ""}The change is saved; it takes effect once you do that.` }} />
      ))}
    </>
  );
};
