// One other power program OXP3 Deck found, with what the user can do about it (DESIGN.md "Conflict rows"): a ✗ line
// with its Details, "Fix for me" / "Fix again" (turns its systemd units off after a confirm), "Undo", "I've handled
// it" for one OXP3 Deck cannot turn off, and "How to fix". The texts are conflicts.ts's.
import { ButtonItem } from "@decky/ui";
import { FC, useEffect, useReducer } from "react";

import { useAction } from "../actions";
import { power_fix, power_options, power_unfix } from "../backend";
import { explainBody, fixConfirm, fixedLines, friendlyName, isCpu, oneLine, undoConfirm } from "../conflicts";
import { notePower, notePowerFix, powerWriter } from "../store";
import type { PowerConflict, PowerFixed, PowerFixRes, PowerInfo } from "../types";
import { when } from "../util";
import { confirm, DetailsSpec, paragraphs, showDetails } from "./confirm";
import { explain, Note, Problem, Status } from "./Hint";

// ---- the fixes made while the quick panel is open (it shows Undo only for those) ------------------------------------

const recent = new Map<string, string[]>();     // id -> the fix answer's notes
const recentSubs = new Set<() => void>();
const changed = () => recentSubs.forEach((f) => { try { f(); } catch { /* a dead subscriber */ } });
const markRecent = (id: string, notes: string[]) => { recent.set(id, notes); changed(); };
/** The quick panel closed: its Undo rows go (the Power tab keeps them). */
export const clearRecentFixes = () => { if (recent.size) { recent.clear(); changed(); } };
const useRecent = () => {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { recentSubs.add(bump); return () => { recentSubs.delete(bump); }; }, []);
  return recent;
};

// ---- texts into rows --------------------------------------------------------------------------------------------------

export const conflictDetails = (row: PowerConflict): DetailsSpec => {
  const e = explainBody(row);
  return { title: e.title, body: paragraphs(e.body), lines: e.lines, linesTitle: e.linesTitle };
};

const fixedDetails = (rec: PowerFixed, notes?: string[]): DetailsSpec => ({
  title: `${friendlyName(rec.id, rec.name)} is off`,
  body: paragraphs([`OXP3 Deck turned it off (${when(rec.at)}). "Undo" turns on again exactly what it turned off.`,
    ...(notes ?? [])]),
  lines: fixedLines(rec),
  linesTitle: "Before OXP3 Deck changed them:",
});

/** The fix's own outcome lines: a step that failed, and the backend's notes (intel_lpmd's top speed). */
const stepErrors = (r: PowerFixRes): string[] =>
  (r.steps ?? []).filter((s) => !s.ok).map((s) => `${s.action} ${s.unit}: ${s.error ?? "failed"}`);

// ---- the flows ------------------------------------------------------------------------------------------------------------

/** Fix for me: asks with the exact commands, then power_fix (never on its own). */
const useFix = (info?: PowerInfo | null) => {
  const act = useAction();
  const fix = (row: PowerConflict) => act.run(`fix:${row.id}`, async () => {
    const d = fixConfirm(row, !!info?.state?.enabled);
    if (!(await confirm({ title: d.title, text: d.text, lines: d.lines, linesTitle: d.linesTitle, ok: d.ok }))) return null;
    await powerWriter.drain();
    const r = await power_fix(row.id);
    const err = notePowerFix(r);
    if ((r.fixed ?? []).some((f) => f.id === row.id)) markRecent(row.id, [...(r.notes ?? []), ...stepErrors(r)]);
    return err;
  });
  const undo = (rec: PowerFixed) => act.run(`undo:${rec.id}`, async () => {
    const d = undoConfirm(rec, when(rec.at));
    if (!(await confirm({ title: d.title, text: d.text, lines: d.lines, linesTitle: d.linesTitle, ok: d.ok }))) return null;
    await powerWriter.drain();
    const r = await power_unfix(rec.id);
    const err = notePowerFix(r);
    if (!(r.fixed ?? []).some((f) => f.id === rec.id)) { recent.delete(rec.id); changed(); }
    return err;
  });
  return { act, fix, undo };
};

/** One active conflict. `quick`: the quick panel (Undo only right after its own fix; the Power tab has them all). */
export const ConflictRow: FC<{ c: PowerConflict; info: PowerInfo | null; quick?: boolean }> = ({ c, info, quick }) => {
  const { act, fix, undo } = useFix(info);
  const rec = useRecent();
  const name = friendlyName(c.id, c.name);
  const details = conflictDetails(c);
  const units = c.fix_units ?? [];
  const came = !!c.fixed?.came_back;
  const ignore = () => act.run(`ignore:${c.id}`, async () => {
    await powerWriter.drain();
    return notePower(await power_options({ ignore: [...(info?.options.ignore ?? []).filter((x) => x !== c.id), c.id] }));
  });
  const busy = !!act.busy;
  return (
    <>
      <Status ok={c.ignored ? null : false} red={c.kind === "blocks" && !c.ignored}
        label={`${name}${c.ignored ? " (handled)" : ""}`} detail={oneLine(c)} details={details} />
      {units.length > 0 && !c.ignored && (
        <ButtonItem layout="below" disabled={busy} onClick={() => fix(c)}
          description={explain(`Turns ${name} off. You can undo it.`)}>
          {act.busy === `fix:${c.id}` ? "Turning it off…" : came ? "Fix again" : "Fix for me"}
        </ButtonItem>
      )}
      {c.fixed && (!quick || rec.has(c.id)) && (
        <ButtonItem layout="below" disabled={busy} onClick={() => undo(c.fixed!)}
          description={explain("Turns back on what OXP3 Deck turned off.")}>
          {act.busy === `undo:${c.id}` ? "Turning it on…" : "Undo"}
        </ButtonItem>
      )}
      {c.fixed && quick && !rec.has(c.id) && <Note>Undo is on the Power tab.</Note>}
      {c.ignorable && !c.ignored && (
        <ButtonItem layout="below" disabled={busy} onClick={ignore}
          description={explain("Only once it no longer changes these settings.")}>
          I've handled it
        </ButtonItem>
      )}
      {!units.length && !c.ignored && (
        <ButtonItem layout="below" onClick={() => showDetails(details)} description={explain("Shows the steps.")}>
          How to fix
        </ButtonItem>
      )}
      <Problem what={name} error={act.error} />
    </>
  );
};

/** The rows of these conflict ids (blockers, or cpu_blocked_by), each with its fix. */
export const ConflictRows: FC<{ ids?: string[] | null; rows?: PowerConflict[] | null; info: PowerInfo | null; quick?: boolean }> =
  ({ ids, rows, info, quick }) => {
    const all = rows ?? (info?.conflicts ?? []).filter((c) => (ids ?? []).includes(c.id));
    return <>{all.map((c) => <ConflictRow key={c.id} c={c} info={info} quick={quick} />)}</>;
  };

/** A record of something OXP3 Deck turned off that does not run now: "<name> is off", with Undo. */
export const FixedRow: FC<{ rec: PowerFixed; notes?: string[] }> = ({ rec, notes }) => {
  const { act, undo } = useFix();
  const name = friendlyName(rec.id, rec.name);
  return (
    <>
      <Status ok label={`${name} is off`} detail={`Turned off ${when(rec.at)}.`} details={fixedDetails(rec, notes)} />
      {(notes ?? []).map((n, i) => <Note key={i}>{n}</Note>)}
      <ButtonItem layout="below" disabled={!!act.busy} onClick={() => undo(rec)}
        description={explain("Re-enables what OXP3 Deck turned off.")}>
        {act.busy ? "Turning it on…" : "Undo: turn it back on"}
      </ButtonItem>
      <Problem what={`Undo ${name}`} error={act.error} />
    </>
  );
};

/** The records whose conflict is gone. `quick`: only the ones fixed while the panel is open. */
export const FixedRows: FC<{ info: PowerInfo | null; quick?: boolean; cpu?: boolean }> = ({ info, quick, cpu }) => {
  const rec = useRecent();
  const active = new Set((info?.conflicts ?? []).map((c) => c.id));
  const list = (info?.fixed ?? []).filter((f) => !active.has(f.id) && (!quick || rec.has(f.id)) && (!cpu || isCpu(f.id)));
  return <>{list.map((f) => <FixedRow key={f.id} rec={f} notes={rec.get(f.id)} />)}</>;
};
