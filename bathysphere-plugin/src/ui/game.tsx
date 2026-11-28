// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * One game's controls (original GameControls.tsx, AutoSetup.tsx, XessLog.tsx, copyopts.ts): XeSS
 * launch options, automatic setup, the game's files and last run, its Proton, advice, its own power
 * profile and the power tip. The game-page section shows all of it; the panel's Games tab too;
 * Quick Access the short form. A game whose launch options OXP3 Deck cannot write (a non-Steam
 * shortcut, or Steam did not return them) gets the same choices as a line to paste.
 */
import { Button, host, Select, Toggle, type Element, type LaunchOptions, type LaunchOptionsChange } from "@bathysphere/sdk";
import { now } from "../core/clock";
import { offerUndo, runUndo, undoLabel } from "../core/undo";
import { settingOn } from "../core/settings";
import { andList, details, dialogTitle, fit } from "../core/text";
import { onOxp3 } from "../device/info";
import { setTdpNow } from "../hw/steam";
import { advice, checks, lastRunRow, suggest } from "../games/advice";
import { acceptFsr, auto, classify, liveChanges, NEVER_AUTO, plan, setMode, tryAgain, undoChange, userChanged } from "../games/autosetup";
import { facts, loadFacts } from "../games/files";
import { DX12_APPIDS, DX12_ARG, knownIssues } from "../games/known";
import { changeLaunch, copyLine, launch, lastWrite, pendingOf, varOf } from "../games/launch";
import { isRunning } from "../games/running";
import { setRecord, xessLog } from "../games/xesslog";
import { power, setGameProfile } from "../power/apply";
import { adviceDetails, adviceLine, dismissTip, MIN_PLAY_S, tipFor } from "../power/advisor";
import { driverPrefix, fsrSupported, RELEASE_DRIVERS } from "../xess/releases";
import { xess } from "../xess/detect";
import { Card, CopyCode, ErrorRow, Status } from "./rows";

const XESS_OPTS = [
  { value: "", label: "Game's own" },
  { value: "latest", label: "Latest (Intel's newest libraries)" },
  { value: "dp4a", label: "DP4a (no XMX)" },
];

/** Frame generation's choices: 2x–4x, 5x–8x with the setting, and a value set by hand. */
function fgOptions(current: string | null): Array<{ value: string; label: string }> {
  const maxFg = settingOn("fgExperimental") ? 8 : 4;
  const opts = [{ value: "", label: "Game default" }, ...Array.from({ length: maxFg - 1 }, (_, i) => ({ value: String(i + 2), label: `${i + 2}x${i + 2 > 4 ? " (experimental)" : ""}` }))];
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: `${current}x` });
  return opts;
}

/** A launch-option change from this page; the game becomes Manual for automatic setup. */
async function apply(appid: number, name: string, change: LaunchOptionsChange): Promise<void> {
  await changeLaunch(appid, name, change, isRunning(appid));
  await userChanged(appid, name);
}

/** Frame generation on a game whose known issue says it crashes asks first. */
async function fgGoAhead(appid: number, name: string, value: string): Promise<boolean> {
  const issue = knownIssues(appid).find((i) => i.fgCrash);
  if (!value || !issue) return true;
  return host.ui.confirm({ title: dialogTitle("Use frame generation in ", name, "?"), body: `${name}\n\n${issue.line}\n\n${issue.detail}`, ok: "Use it anyway", destructive: true });
}

/** Why the last Undo, Try again or FSR → XeSS of a game did not go through; a "quit first" lasts while it runs. */
const notes = new Map<number, { text: string; whileRunning: boolean }>();

async function act(appid: number, run: () => Promise<string | null>): Promise<void> {
  const text = await run();
  if (text) notes.set(appid, { text, whileRunning: isRunning(appid) });
  else notes.delete(appid);
}

function noteRows(appid: number): Element[] {
  const n = notes.get(appid);
  if (n && n.whileRunning && !isRunning(appid)) notes.delete(appid);
  const shown = notes.get(appid);
  return shown ? [<Status label="Not changed" line={shown.text} tone="warn" />] : [];
}

/** The pending row, the last write's copy line or typo card. */
function writeRows(appid: number, name: string): Element[] {
  const out: Element[] = [];
  const p = pendingOf(appid);
  if (p) out.push(<Status label={`Saved when you quit ${name}`} line={p.error ?? "Steam takes launch options only while the game is closed."} tone={p.error ? "bad" : "neutral"} more={`Waiting: ${[...Object.entries(p.vars).map(([k, v]) => (v === null ? `no ${k}` : `${k}=${v}`)), ...p.add, ...p.remove.map((a) => `no ${a}`)].join(" ")}`} />);
  const w = lastWrite.get(appid);
  if (w?.kind === "copy") {
    out.push(<Status label="Steam did not take the change" line={w.why} tone="warn" more="Copy this line into the game's Properties, General, Launch options." />);
    if (w.line) out.push(<CopyCode text={w.line} />);
  }
  if (w?.kind === "error") out.push(<ErrorRow label="Launch options: not changed" error={w.error} />);
  if (w?.kind === "typo") out.push(<Status label="Launch options typo" line="%command without the closing %: fix it in Steam." tone="bad" />, <Card id="launch-typo" />);
  return out;
}

/** Automatic setup rows of one game (mode, changes with Undo / Try again, offers). */
function autoRows(appid: number, name: string): Element[] {
  if (!auto.value.on) return [];
  const g = auto.value.games[String(appid)];
  const f = facts.get(appid).value;
  const lo = launch.get(appid).value;
  const out: Element[] = [];
  const cls = classify(appid, name, f);
  if (cls.cls === "skipped") return [<Status label="Automatic setup: skipped" line={cls.why} />];
  out.push(
    <Select
      label="Automatic setup for this game"
      options={[{ value: "auto", label: "Automatic" }, { value: "manual", label: "Manual" }]}
      value={g?.mode ?? "auto"}
      onChange={(m) => setMode(appid, name, m as "auto" | "manual")}
      details={details("Automatic or Manual", [g?.modeWhy ?? "Automatic: OXP3 Deck sets the game up after you quit it. Manual: it changes nothing for this game."])}
    />,
  );
  if (g?.lastError) out.push(<Status label="Automatic setup: did not work" line={g.lastError} tone="bad" />);
  for (const c of liveChanges(g)) {
    out.push(<Status label={fit(`Launch options: ${c.label}`)} line={c.why} more={[c.why, c.accepted ? "You chose it." : null]} />, <Button label={`Undo ${fit(c.label, 24)}`} onClick={() => act(appid, () => undoChange(appid, c.id, isRunning(appid)))} />);
  }
  for (const c of (g?.changes ?? []).filter((x) => x.state === "rolled_back")) {
    out.push(<Status label={fit(`${name} closed within a minute after ${c.label}`)} line="OXP3 Deck undid that change." tone="warn" />, <Button label="Try again" onClick={() => act(appid, () => tryAgain(appid, c.id, isRunning(appid)))} />);
  }
  if (f && lo && g?.mode !== "manual") {
    const p = plan(appid, name, g, f, lo, !!xess.value?.installed, fsrSupported(xess.value?.version));
    for (const o of p.offers) {
      out.push(<Status label={`Also possible: ${o.label}`} line={o.line} more={o.why} />);
      if (o.id === "fsr") {
        out.push(
          <Button
            label="Use FSR → XeSS"
            onClick={async () => {
              const ok = await host.ui.confirm({ title: dialogTitle("FSR → XeSS for ", name, "?"), body: `${name}\n\n${o.why}\n\nIt is recorded like an automatic change, with Undo. A quick exit afterwards does not undo it.`, ok: "Use it" });
              if (ok) await act(appid, () => acceptFsr(appid, name, isRunning(appid)));
            }}
          />,
        );
      } else out.push(<Card id="ge-proton" />);
    }
  }
  return [...out, ...noteRows(appid)];
}

/** What the game's files and last run show (needs the facts read in the background). */
function fileRows(appid: number, full: boolean): Element[] {
  const c = facts.get(appid);
  const again = <Button label="Read the game's files again" onClick={() => loadFacts(appid, true)} />;
  if (c.error) return [<ErrorRow label="Game files: not read" error={{ code: c.error.code, line: c.error.message.slice(0, 80), message: c.error.message, tone: "warn" }} />, again];
  const f = c.value;
  if (!f) return [<Status label="Checking the game's files…" />];
  const out: Element[] = [];
  const x = xess.value;
  for (const ch of checks(f)) out.push(<Status label={ch.label} line={ch.line} tone="bad" more={ch.detail} {...(ch.lines ? { lines: ch.lines } : {})} />);
  const lr = lastRunRow(f.lastRun);
  const run = f.lastRun;
  if (lr) {
    out.push(
      <Status
        label={lr.label}
        line={lr.line}
        {...(lr.bad ? { tone: "warn" as const } : {})}
        more={[
          run?.fallback ? `Fallback: ${run.fallback}` : null,
          run?.canary ? "The patched driver's canary file is there: it saw XeSS's self-test in this game." : run?.trace ? "The shim's trace log is there, but no canary file: the patched driver saw no XeSS self-test, so the game may not have used XeSS." : "No trace log: turn on Save XeSS logs and start the game to see whether the shim loads.",
          run?.xellBuiltin ? "XeLL ran in cross-vendor mode (its built-in context)." : null,
          run?.xellUnsupported ? "XeLL refused the GPU (unsupported device)." : null,
        ]}
      />,
    );
  } else if (full) out.push(<Status label="Last run" line="No logs yet." more="Turn on Save XeSS logs and start the game once to see what XeSS did." />);
  if (!full) return out;
  if (f.dlls.length) out.push(<Status label={`XeSS and FidelityFX files: ${f.dlls.length}`} line={andList(f.dlls.slice(0, 3).map((d) => `${d.name} ${d.version ?? "?"}`))} lines={f.dlls.map((d) => `${d.path}: ${d.version ?? "no version"}`)} more={f.truncated ? "The folder is very large; only part of it was searched." : "Links XESS=latest leaves while a game runs are not listed (the host does not follow links)."} />);
  if (f.compatTool) out.push(<Status label={`Proton: ${f.compatTool.name}`} line={f.systemProton ? "System Proton: XeSS stays on DP4a here." : f.lastRun?.trace ? "The XeSS add-on loaded at the last run." : "Whether it carries the XeSS add-on shows after a run."} tone={f.systemProton ? "warn" : "neutral"} more={f.compatTool.perGame ? "Chosen for this game." : "Steam's default for all games."} />);
  if (f.systemProton) out.push(<Card id="ge-proton" />);
  const tips = advice(f, !!x?.installed, fsrSupported(x?.version));
  if (tips.length) out.push(<Status label="Tips" line={tips[0]} lines={tips} more={tips} />);
  out.push(again);
  return out;
}

/** The power tip for the running game (Quick Access This game). */
export function tipRows(appid: number): Element[] {
  if (!onOxp3() || !settingOn("powerTips") || !power.value.enabled || !isRunning(appid)) return [];
  const t = tipFor(appid);
  const out: Element[] = [];
  const undo = undoLabel("tip");
  if (undo) out.push(<Button label={undo} onClick={() => runUndo("tip")} />);
  if (!t.advice) {
    out.push(<Status label="Power tips" line={t.sampling ? `Learning this game: ${Math.floor(t.seconds / 60)} of ${MIN_PLAY_S / 60} min.` : "Collecting while the game runs."} />);
    return out;
  }
  const a = t.advice;
  out.push(<Status label="Power tip" line={adviceLine(a)} tone="warn" more={adviceDetails(a)} />);
  if (a.suggestW !== null) {
    const w = a.suggestW;
    out.push(
      <Button
        label={`Use ${w} W`}
        onClick={async () => {
          const prev = a.tdpW;
          const o = await setTdpNow(w);
          if (o.ok) offerUndo("tip", `Undo: back to ${prev} W`, async () => void (await setTdpNow(prev)));
        }}
      />,
    );
  }
  out.push(<Button label="Dismiss" onClick={() => dismissTip(appid, a)} />);
  return out;
}

/** The per-game power profile switch. */
function profileRows(appid: number, name: string): Element[] {
  if (!onOxp3()) return [];
  const own = !!power.value.profiles[String(appid)];
  return [
    <Toggle
      label={`Separate power profile for ${fit(name, 40)}`}
      description={own ? "This game has its own values." : "Uses the Default profile."}
      value={own}
      onChange={async (on) => {
        if (!on) {
          const ok = await host.ui.confirm({ title: dialogTitle("Delete the profile of ", name, "?"), body: `${name} then uses the Default profile.`, ok: "Delete", destructive: true });
          if (!ok) return;
        }
        await setGameProfile(appid, name, on);
      }}
      details={details("Separate power profile", ["A copy of Default that applies while this game runs, also with OXP3 Deck closed. Edit it in the Power tab or the Power group while the game runs.", power.value.options.perGame ? null : "Per-game profiles are off (Power tab), so it is kept but not used."])}
    />,
  ];
}

// ---- a game OXP3 Deck cannot write: the choices as a line to paste (copyopts.ts "shortcut", "unreadable")

interface Draft {
  xess: string;
  fg: string;
  dx12: boolean;
}

/** What the user picked per game here, for the line to paste (kept until OXP3 Deck restarts). */
const drafts = new Map<number, Draft>();

/** The draft as launch options: the picked keys, %command%, the argument. Every value is a fixed choice. */
const draftLine = (d: Draft): string => {
  const vars = [d.xess && `XESS=${d.xess}`, d.fg && `XESS_FG=${d.fg}`].filter(Boolean);
  return vars.length || d.dx12 ? [...vars, "%command%", ...(d.dx12 ? [DX12_ARG] : [])].join(" ") : "";
};

/** XeSS choices for a non-Steam shortcut or a game whose launch options Steam did not return. */
export function draftRows(appid: number, name: string, why: "shortcut" | "unreadable"): Element[] {
  const d = drafts.get(appid) ?? { xess: "", fg: "", dx12: false };
  const set = (change: Partial<Draft>): void => void drafts.set(appid, { ...d, ...change });
  const line = draftLine(d);
  const out: Element[] = [
    <Status
      label="Paste these launch options"
      line={why === "shortcut" ? "OXP3 Deck can't write them for this game." : "Steam didn't return them, so OXP3 Deck does not write them."}
      more={[
        why === "shortcut" ? "Bathysphere never changes a non-Steam shortcut's launch options." : "Writing without reading them first would replace yours. This line has only what you pick here.",
        `Pick the settings below, copy the line and paste it into ${name}'s Properties, Launch options (add your own words to it). Takes effect: restart the game.`,
      ]}
    />,
    <Select label="XeSS version" options={XESS_OPTS} value={d.xess} onChange={(x) => set({ xess: x })} />,
    <Select
      label="Frame generation"
      options={fgOptions(d.fg || null)}
      value={d.fg}
      onChange={async (x) => {
        if (await fgGoAhead(appid, name, x)) set({ fg: x });
      }}
    />,
    <Toggle label="Start in DirectX 12" description={DX12_APPIDS.includes(appid) ? "Needed for XeSS frame generation in this game." : "Only for games that know -dx12."} value={d.dx12} onChange={(on) => set({ dx12: on })} />,
  ];
  if (line) out.push(<CopyCode text={line} />);
  return out;
}

// ---- the game's controls ---------------------------------------------------------------------------

/** The game's XeSS controls and everything else. `full` adds the rows Quick Access leaves out. */
export async function gameControls(appid: number, name: string, full: boolean): Promise<Element[]> {
  const lc = launch.get(appid);
  await lc.load();
  loadFacts(appid);
  const lo = lc.value;
  const out: Element[] = [];
  for (const i of knownIssues(appid)) out.push(<Status label={i.label} line={i.line} tone={i.fgCrash ? "bad" : "warn"} more={[i.detail, `Source: ${i.source}`]} />);
  if (!lo) {
    out.push(<ErrorRow label="Launch options: not read" error={lc.error ? { code: lc.error.code, line: lc.error.code === "EPERM" ? "Not a Steam game, or not allowed." : lc.error.message.slice(0, 80), message: lc.error.message, tone: "warn" } : null} />);
    if (lc.error) out.push(...draftRows(appid, name, "unreadable"), <Button label="Read launch options again" onClick={() => launch.get(appid).invalidate()} />);
    return [...out, ...fileRows(appid, full)];
  }
  if (lo.warnings.includes("unparsed")) {
    out.push(<Status label="Launch options typo" line="Steam passes everything as game arguments; no XeSS setting reaches the game." tone="bad" more={`Launch options now: ${lo.text}`} />, <Card id="launch-typo" />);
  }
  out.push(...autoRows(appid, name), ...writeRows(appid, name));
  const xv = varOf(lo, "XESS");
  out.push(
    <Select
      label="XeSS version"
      options={XESS_OPTS}
      value={xv === "latest" || xv === "dp4a" ? xv : ""}
      onChange={(x) => apply(appid, name, { vars: { XESS: x || null } })}
      details={details("XeSS version", ["Game's own: the XeSS files the game ships. Latest: Intel's newest libraries while the game runs (games older than XeSS 2.0.2.68 need it for the fast mode). DP4a: XeSS without the XMX cores. Needs a Proton with the XeSS hook (GE-Proton). Takes effect: Restart the game."])}
    />,
  );
  const fg = varOf(lo, "XESS_FG");
  out.push(
    <Select
      label="Frame generation"
      options={fgOptions(fg)}
      value={fg ?? ""}
      onChange={async (x) => {
        if (await fgGoAhead(appid, name, x)) await apply(appid, name, { vars: { XESS_FG: x || null } });
      }}
      details={details("Frame generation", ["XeSS frame generation in games that offer it (libxess_fg.dll). 5x to 8x are experimental (setting \"Offer 5x to 8x frame generation\"). Exclusive fullscreen turns it off: use borderless. Takes effect: Restart the game."])}
    />,
  );
  const f = facts.get(appid).value;
  if (fg && f && !f.dlls.some((d) => d.name === "libxess_fg.dll") && f.dlls.length) out.push(<Status label="No XeSS frame generation in this game" line="XESS_FG has nothing to act on." tone="warn" />);
  const logOn = varOf(lo, "XESS_LOG") === "1";
  const rec = xessLog.value.games[String(appid)];
  out.push(
    <Toggle
      label="Save XeSS logs"
      description={logOn ? (rec?.keep ? "Logging on: costs performance. Kept on." : "For one run; costs performance.") : "Off."}
      value={logOn}
      onChange={async (on) => {
        await apply(appid, name, { vars: { XESS_LOG: on ? "1" : null } });
        await setRecord(appid, on ? { onAt: now(), keep: false, offAt: null, at: now() } : null);
      }}
    />,
  );
  if (logOn) out.push(<Toggle label="Keep logging on" value={!!rec?.keep} onChange={(keep) => setRecord(appid, { onAt: rec?.onAt ?? now(), keep, offAt: null, at: now() })} />);
  if (!logOn && rec?.offAt) out.push(<Status label="Logging turned off after one run" line="The logs of that run stay in the game's prefix." />);
  if (full) out.push(...fullLaunchRows(appid, name, lo));
  out.push(
    <Status label="Launch options" line={lo.text ? fit(lo.text) : "(empty)"} more={[lo.text || "(empty)", lo.warnings.includes("wrapper") ? "A program runs the game (a word before %command%); the settings above still reach the game." : null, lo.warnings.includes("tail") ? "Something follows the game's arguments (a pipe or redirect); it is kept as it is." : null, lo.warnings.includes("fromFile") ? "Read from Steam's files while Steam runs: may be out of date." : null]} />,
    <Button label="Read launch options again" onClick={() => launch.get(appid).invalidate()} />,
  );
  out.push(...profileRows(appid, name), ...fileRows(appid, full));
  return out;
}

/** Driver, compatibility mode, DirectX 12, FSR → XeSS and the copy line (the full form only). */
function fullLaunchRows(appid: number, name: string, lo: LaunchOptions): Element[] {
  const out: Element[] = [];
  const x = xess.value;
  const mesa = varOf(lo, "MESA");
  const drivers = [...new Set([...(RELEASE_DRIVERS[x?.version ?? ""] ?? []), ...(x?.status.driver ? [x.status.driver] : [])].map(driverPrefix))];
  if (mesa && !drivers.includes(mesa)) drivers.push(mesa);
  if (drivers.length) {
    out.push(<Select label="Graphics driver" options={[{ value: "", label: "Default" }, ...drivers.map((d) => ({ value: d, label: `Mesa ${d}` }))]} value={mesa ?? ""} onChange={(d) => apply(appid, name, { vars: { MESA: d || null } })} />);
  }
  out.push(
    <Toggle label="Compatibility mode" description="Hides the Intel GPU from the game (Mesa's own profile)." value={varOf(lo, "force_vk_vendor") === "-1"} onChange={(on) => apply(appid, name, { vars: { force_vk_vendor: on ? "-1" : null } })} />,
    <Toggle
      label="Start in DirectX 12"
      description={DX12_APPIDS.includes(appid) ? "Needed for XeSS frame generation in this game." : "Only for games that know -dx12."}
      value={lo.managed.args.includes(DX12_ARG)}
      onChange={(on) => apply(appid, name, { args: on ? { add: [DX12_ARG] } : { remove: [DX12_ARG] } })}
    />,
  );
  const fsr = varOf(lo, "FSR");
  const fsrFg = varOf(lo, "FSR_FG");
  if (fsrSupported(x?.version) || fsr || fsrFg) {
    const cur = fsr === "xess" && fsrFg === "inject" ? "inject" : fsr === "xess" ? "xess" : fsrFg === "xess" ? "fg" : "";
    out.push(
      <Select
        label="FSR → XeSS"
        options={[{ value: "", label: "Off" }, { value: "xess", label: "FSR upscaling and frame generation on XeSS" }, { value: "fg", label: "Only FSR frame generation on XeSS" }, { value: "inject", label: "FSR on XeSS, add XeSS frame generation" }]}
        value={cur}
        onChange={async (v) => {
          const risky = knownIssues(appid).find((i) => i.fsrRisk);
          if (v && risky && !(await host.ui.confirm({ title: dialogTitle("FSR → XeSS for ", name, "?"), body: `${name}\n\n${risky.line}\n\n${risky.detail}`, ok: "Use it anyway", destructive: true }))) return;
          const vars = v === "xess" ? { FSR: "xess", FSR_FG: null } : v === "fg" ? { FSR: null, FSR_FG: "xess" } : v === "inject" ? { FSR: "xess", FSR_FG: "inject" } : { FSR: null, FSR_FG: null };
          await apply(appid, name, { vars });
        }}
      />,
    );
  }
  out.push(...copyRows(appid, lo));
  return out;
}

/**
 * "Copy launch options" (copyopts.ts copyLine): Steam's text with the change that waits for the game
 * to quit and the keys this game needs but lacks (never frame generation, nothing a known issue
 * rules out), plus its DirectX 12 argument with frame generation. No row when the line is empty.
 */
function copyRows(appid: number, lo: LaunchOptions): Element[] {
  const p = pendingOf(appid);
  const vars: Record<string, string | null> = { ...(p?.vars ?? {}) };
  const add = [...(p?.add ?? [])];
  const remove = p?.remove ?? [];
  const needs: string[] = [];
  const f = facts.get(appid).value;
  const x = xess.value;
  const never = new Set([...NEVER_AUTO, ...knownIssues(appid).flatMap((i) => i.autoNever)]);
  for (const sg of f ? suggest(f, !!x?.installed, fsrSupported(x?.version)) : []) {
    if (never.has(sg.key) || sg.key in vars || lo.managed.vars[sg.key] !== undefined) continue;
    vars[sg.key] = sg.value;
    needs.push(`${sg.key}=${sg.value}`);
  }
  const fgAfter = "XESS_FG" in vars ? vars.XESS_FG : lo.managed.vars.XESS_FG;
  if (DX12_APPIDS.includes(appid) && fgAfter && !lo.managed.args.includes(DX12_ARG) && !add.includes(DX12_ARG) && !remove.includes(DX12_ARG)) {
    add.push(DX12_ARG);
    needs.push(DX12_ARG);
  }
  const line = copyLine(lo.text, { vars, args: { add, remove } });
  if (!line) return [];
  return [
    <Status
      label="Copy launch options"
      line={p ? "With the change that waits for the game to quit." : needs.length ? "Includes what this game needs." : "To paste them by hand."}
      more={[needs.length ? `Adds ${needs.join(" ")}, which OXP3 Deck suggests for this game; the rest is your own text.` : null, "Paste it into the game's Properties, General, Launch options, in place of what is there. Takes effect: restart the game."]}
    />,
    <CopyCode text={line} />,
  ];
}
