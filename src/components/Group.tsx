// A collapsible group of the quick panel (DESIGN.md "Quick Access groups"): one header row that A (or a tap) opens
// and closes, its summary while closed, and the alerts that a closed group still shows. The open state is remembered
// on this device (util.ts remember, key quickGroups), read once and synchronously so the panel never jumps.
import { Field, PanelSection, PanelSectionRow } from "@decky/ui";
import { createContext, FC, Fragment, ReactNode, useContext, useEffect, useReducer, useRef } from "react";
import { FaChevronDown, FaChevronRight } from "react-icons/fa";

import { Alert, GroupId, GROUPS_KEY, GroupState, headerLine, isOpen, makePins, parseGroups, toggled } from "../quickgroups";
import { remember } from "../util";
import { Problem, RED } from "./Hint";

export type { GroupId };

// ---- the remembered open state (one store for every group) ---------------------------------------------------------

let state: GroupState | null = null;
const subs = new Set<() => void>();
const current = (): GroupState => (state ??= parseGroups(remember.get(GROUPS_KEY)));

/** Which groups are open, and toggling one (stored at once). */
export const useGroups = () => {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { subs.add(bump); return () => { subs.delete(bump); }; }, []);
  const s = current();
  return {
    open: (id: GroupId) => isOpen(s, id),
    toggle: (id: GroupId) => {
      state = toggled(current(), id);
      remember.set(GROUPS_KEY, JSON.stringify(state));
      if (isOpen(state, id)) clearPinned(id);      // opened: the user is in the group again
      subs.forEach((f) => { try { f(); } catch { /* a dead subscriber */ } });
    },
  };
};

// ---- problems that survive a close ---------------------------------------------------------------------------------

/** The group a row renders in (its open body only), so an action's error can stay pinned once the group closes. */
const GroupCtx = createContext<GroupId | null>(null);

const pins = makePins();
const pinSubs = new Set<() => void>();
let pinSeq = 0;
const pinChanged = () => pinSubs.forEach((f) => { try { f(); } catch { /* a dead subscriber */ } });
/** Forgets a group's pinned errors (it was opened, or "This game" now shows another game). */
export const clearPinned = (id: GroupId) => { if (pins.clear(id)) pinChanged(); };

/**
 * Keep `error` (an action's last error, shown by a Problem row) for the group this hook renders in: once the group
 * is closed, its header and a red row show it. Cleared when the error clears, the group is opened again, or the row
 * goes away while its group is open (the panel was left, the row is gone: nothing could clear it later).
 */
export const usePinned = (error: string | null | undefined) => {
  const g = useContext(GroupCtx);
  const id = useRef(0);
  if (!id.current) id.current = ++pinSeq;
  useEffect(() => { if (g && pins.set(g, id.current, error)) pinChanged(); }, [g, error]);
  useEffect(() => () => { if (g && pins.drop(g, id.current, isOpen(current(), g))) pinChanged(); }, [g]);
};

const usePinnedOf = (id: GroupId): string[] => {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { pinSubs.add(bump); return () => { pinSubs.delete(bump); }; }, []);
  return pins.of(id);
};

// ---- the group -----------------------------------------------------------------------------------------------------

/**
 * A group: a PanelSection without a title (its title is a plain, unfocusable string), the header as its first row,
 * then the rows while open, or only the `alerts` rows while closed (the body is not mounted then).
 */
export const Group: FC<{ id: GroupId; title: string; summary: string; alert?: Alert | null; alerts?: ReactNode; children: ReactNode }> =
  ({ id, title, summary, alert, alerts, children }) => {
    const g = useGroups();
    const open = g.open(id);
    const kept = usePinnedOf(id);
    const shownAlert = alert ?? (kept.length ? { label: `${title}: did not work`, line: kept[0] } : null);
    const line = headerLine(summary, shownAlert);
    const Chevron = open ? FaChevronDown : FaChevronRight;
    return (
      <PanelSection>
        <PanelSectionRow key="header">
          <Field focusable highlightOnFocus bottomSeparator="standard"
            onActivate={() => g.toggle(id)} onOKActionDescription={open ? "Close" : "Open"}
            label={
              <span style={{ fontWeight: "bold", ...(shownAlert ? { color: RED } : {}) }}>
                <Chevron style={{ fontSize: "0.8em", marginRight: 8 }} />
                {shownAlert && <span style={{ marginRight: 8 }}>✗</span>}{title}
              </span>
            }
            description={!open || shownAlert
              ? <span style={{ whiteSpace: "normal", ...(line.red ? { color: RED } : {}) }}>{line.text}</span> : undefined} />
        </PanelSectionRow>
        {open ? (
          <GroupCtx.Provider key="body" value={id}>{children}</GroupCtx.Provider>
        ) : (
          <Fragment key="alerts">
            {alerts}
            {kept.length > 0 && <PanelSectionRow>{kept.map((e, n) => <Problem key={n} what={title} error={e} />)}</PanelSectionRow>}
          </Fragment>
        )}
      </PanelSection>
    );
  };
