// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// Based on ClawDeck's per-game tab (src/tabs/PerGame.tsx).
// The option descriptions follow xess-xmx-linux's docs/launch-options.md (Copyright (c) 2026 HHHHanasak1), partly
// in its words; the project's MIT licence is in THIRD_PARTY_NOTICES.md.
// One game's xess-xmx-linux options, written straight into its Steam launch options (before %command%), plus what
// the backend found about the game (its XeSS DLLs, its Proton, the last run's logs).
import { ButtonItem, DropdownItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { FC, useEffect, useMemo, useRef, useState } from "react";

import { game_info, opti_info, xess_state } from "../backend";
import { driverPrefix, dx12Arg, dx12Known, fixTypo, fsrSupported, hasArg, managed, ManagedKey, parse, setArg, setManaged } from "../launchopts";
import { getLaunchOptions, isSteamApp, RunningApp, setLaunchOptions } from "../steam";
import { EFFECTS } from "../effects";
import { notePending, useResource } from "../store";
import type { GameInfo, GameInfoRes, GameIssue, OptiInfoRes, XessDriver, XessStateRes } from "../types";
import { remember, when } from "../util";
import { firstSentence } from "../text";
import { confirm, DetailsSpec, paragraphs } from "./confirm";
import { useAutoLog } from "./AutoLaunch";
import { autoOnFor, markManual, useAutoState } from "../autostate";
import { AutoSetupRows } from "./AutoSetup";
import { CopyLaunchRows } from "./CopyLaunch";
import { OptiRows } from "./OptiControls";
import { Pending } from "./Effect";
import { usePinned } from "./Group";
import { Code, explain, explainWhen, label, Note, Problem, Status, WithDetails } from "./Hint";

type Opt = { data: string; label: string };

/** The general frame generation warning (owner report: XeSS frame generation from the launch options crashed MH Wilds). */
export const FG_CRASH_LINE = "Frame generation can crash some games; if a game crashes, turn it off.";

/** The FSR=/FSR_FG= pair as one choice (docs/fsr-frame-generation.md in xess-xmx-linux 20261104). */
const FSR_MODES: { data: string; label: string; set: { FSR: string | null; FSR_FG: string | null }; line: string; does: string }[] = [
  { data: "", label: "Game's own FSR", set: { FSR: null, FSR_FG: null }, line: "Uses the game's own FSR.", does: "The game's FSR stays as it is." },
  { data: "all", label: "FSR on XeSS", set: { FSR: "xess", FSR_FG: null }, line: "FSR upscaling and frame gen run on XeSS.",
    does: "FSR=xess: the game's FSR 3.1+ upscaling runs on XeSS super resolution and its FSR frame generation on XeSS frame generation (with the frame generation choice above: multi-frame). Only for games with FSR 3.1+ and no XeSS; choose FSR in the game." },
  { data: "fg", label: "FSR frame gen on XeSS", set: { FSR: null, FSR_FG: "xess" }, line: "Only FSR frame gen runs on XeSS.",
    does: "FSR_FG=xess: only the game's FSR 3.1+ frame generation runs on XeSS frame generation; the game's FSR upscaling stays." },
  { data: "inject", label: "Add XeSS frame gen", set: { FSR: "xess", FSR_FG: "inject" }, line: "Adds XeSS frame gen to FSR upscaling.",
    does: "FSR=xess FSR_FG=inject: XeSS frame generation for a game with FSR 3.1+ upscaling but no FSR frame generation (Forza Horizon 6). Choose FSR upscaling in the game; the HUD is interpolated too." },
];

const fsrMode = (fsr?: string, fg?: string): string => {
  if (!fsr && !fg) return "";
  if (fsr === "xess" && !fg) return "all";
  if (!fsr && fg === "xess") return "fg";
  if (fsr === "xess" && fg === "inject") return "inject";
  return "custom";
};

/** One option per installed driver prefix (26.1, 26.3): MESA= takes a prefix, which survives an update. */
const driverOptions = (drivers: XessDriver[]): Opt[] => {
  const seen = new Map<string, string[]>();
  for (const d of drivers) {
    const p = driverPrefix(d.version);
    seen.set(p, [...(seen.get(p) ?? []), d.version]);
  }
  return [...seen.entries()].map(([p, versions]) => ({ data: p, label: `Mesa ${versions.join(" / ")}` }));
};

const lastRunLine = (lr: NonNullable<GameInfoRes["game"]>["last_run"]): { ok: boolean | null; label: string; line: string; detail: string } => {
  if (!lr) return { ok: null, label: "Last run: no logs", line: "Start the game once to see how XeSS ran.", detail: "Nothing from xess-xmx-linux in this game's prefix yet: start it once (with \"Save XeSS logs\" on for the details)." };
  if (lr.fallback) return { ok: false, label: "Last run: slower mode", line: "XeSS fell back to the slower mode.", detail: `XeSS fell back to DP4a: ${lr.fallback}` };
  if (lr.compile_failed) return { ok: false, label: "Last run: slower mode", line: "The fast driver couldn't prepare XeSS.", detail: "The patched driver could not build one of XeSS's kernels; ~/.cache/xess-xmx/compile.log has the line." };
  if (lr.canary) return { ok: true, label: "Last run: fast mode used", line: "XeSS ran on the fast cores.", detail: "The patched driver saw XeSS's self-test in this game (XeSS on the XMX cores)." };
  return { ok: null, label: "Last run: no sign of fast mode", line: "The game may not have used XeSS.", detail: lr.trace ? "The shim was loaded (trace log), but the patched driver saw no XeSS self-test: the game may not have used XeSS." : "No trace log: turn \"Save XeSS logs\" on and start the game to see whether the shim loads." };
};

/** The Proton's one line up front: ready, needs the add-on, or partly. */
const protonShort = (g: GameInfo): string =>
  g.compat_tool_shimmed === false ? "Needs the XeSS add-on"
    : g.compat_tool_shimmed === true ? (g.compat_tool_hook === false ? "Some settings won't work" : "XeSS fast mode ready")
    : "Unknown";

const toolName = (g: GameInfo): string =>
  g.compat_tool ?? (g.default_compat_tool ? `${g.default_compat_tool} (Steam's default)` : "Steam's default");

/** The shim (igdext64.dll: XeSS on the XMX cores) and the hook (user_settings.py: the XESS / FSR shorthands). */
const protonLine = (g: GameInfo): string => {
  if (g.compat_tool_shimmed === false) {
    return `Its igdext64.dll is not xess-xmx-linux's shim, so XeSS stays on DP4a. ${g.compat_tool_system
      ? "Add the shim to the system Protons on the XeSS tab, or pick" : "Run the XeSS install again, or pick"} another Proton in the game's Properties → Compatibility.`;
  }
  if (g.compat_tool_shimmed === true) {
    return g.compat_tool_hook === false
      ? "Has the shim (XeSS on the XMX cores) but not the hook: XESS=latest, XESS=dp4a, XESS_LOG and FSR do nothing on this Proton."
      : g.compat_tool_hook ? "Has the shim (XeSS on the XMX cores) and the hook (XESS, XESS_LOG and FSR work)." : "Has the shim (XeSS on the XMX cores).";
  }
  return g.compat_tool_dir ? "This Proton has no driver store of its own (no igdext64.dll); see the advice below."
    : "Its folder was not found, so whether it carries the shim is unknown.";
};

export const GameControls: FC<{ app: RunningApp; quick?: boolean; running?: boolean }> = ({ app, quick, running }) => {
  const steam = isSteamApp(app.appid);
  const xs = useResource<XessStateRes>("xess", xess_state);
  // the backend knows Steam games only (appmanifest, compatdata); a shortcut gets no game check
  const gi = useResource<GameInfoRes>(steam ? `game:${app.appid}` : null, () => game_info(app.appid), { fresh: true });
  const [opts, setOpts] = useState<string | null | undefined>(undefined);   // undefined: reading; null: unreadable
  const [draft, setDraft] = useState("");          // what to paste, when the plugin cannot write it itself
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  usePinned(err);       // in the quick panel's This game: stays shown once it is closed
  const [saved, setSaved] = useState(false);
  const [wanted, setWanted] = useState<string | null>(null);   // the last write Steam refused or changed: to copy
  const [rev, setRev] = useState(0);              // remounts the dropdowns when the value is not what was picked
  const [experimental, setExperimental] = useState(() => remember.get("fgExperimental") === "1");

  const seq = useRef(0);
  const read = async () => {
    const mine = ++seq.current;   // a read for a game the panel has left since is dropped
    setOpts(undefined);
    const o = steam ? await getLaunchOptions(app.appid) : null;
    if (mine !== seq.current) return;
    setOpts(o);
    setWanted(null);
    setRev((n) => n + 1);
  };
  useEffect(() => { setErr(null); setSaved(false); setDraft(""); setWanted(null); read(); }, [app.appid]);

  const writable = steam && typeof opts === "string";
  const text = writable ? (opts as string) : draft;
  const p = useMemo(() => parse(text), [text]);
  const cur = managed(p);
  const blocked = p.typo && !p.hasCommand;
  const x = xs.data?.xess ?? null;
  const drivers = x?.drivers ?? [];
  const defaultDriver = drivers.find((d) => d.default)?.version ?? x?.preferred_driver ?? null;
  const showFsr = fsrSupported(x?.version) || !!x?.features?.fsr || !!cur.FSR || !!cur.FSR_FG;
  const disabled = busy || opts === undefined || blocked;
  const nextStart = running ? `Applies when you start ${app.name} again.` : `Applies at the next start of ${app.name}.`;

  /** `what`: the setting that changed (its pending row while the game runs: it applies at the next start). */
  const write = async (next: string, what?: { id: string; label: string }) => {
    if (next === text) return;
    setErr(null);
    if (!writable) { setDraft(next); setSaved(false); return; }
    setBusy(true);
    const r = await setLaunchOptions(app.appid, next);
    setBusy(false);
    const now = r.text ?? (r.ok ? next : text);
    setOpts(now);
    if (now !== next) setRev((n) => n + 1);
    setErr(r.ok ? null : r.error);
    setWanted(r.ok ? null : next);
    // while the game runs, the pending row ("Restart … to apply") says it instead of "Saved"
    setSaved(r.ok && !(running && what));
    // a change by hand: the automatic setup leaves this game alone from now on (Manual)
    if (r.ok) markManual(app.appid, "You changed its settings here.");
    if (r.ok && running && what) notePending({ id: what.id, effect: EFFECTS["game.xess"], label: what.label, appid: app.appid, game: app.name });
  };
  const change = (c: Partial<Record<ManagedKey, string | null>>, id: string, what: string) => write(setManaged(text, c), { id, label: what });
  // a greyed-out control says why
  const why = blocked ? "Fix the launch options typo first." : opts === undefined ? "Reading the launch options…" : null;

  const xessOpts = useMemo<Opt[]>(() => {
    const o = [{ data: "", label: "Game's own" }, { data: "latest", label: "Latest (package)" }, { data: "dp4a", label: "DP4a, no XMX" }];
    return cur.XESS && !o.some((v) => v.data === cur.XESS) ? [...o, { data: cur.XESS, label: `${cur.XESS} (unknown)` }] : o;
  }, [cur.XESS]);
  const fgOpts = useMemo<Opt[]>(() => {
    const o: Opt[] = [{ data: "", label: "Game default" }, { data: "2", label: "2x" }, { data: "3", label: "3x" }, { data: "4", label: "4x" }];
    const n = Number(cur.XESS_FG);
    for (const k of [5, 6, 7, 8]) if (experimental || n === k) o.push({ data: String(k), label: `${k}x (experimental)` });
    return cur.XESS_FG && !o.some((v) => v.data === cur.XESS_FG) ? [...o, { data: cur.XESS_FG, label: `${cur.XESS_FG} (unknown)` }] : o;
  }, [cur.XESS_FG, experimental]);
  const mesaOpts = useMemo<Opt[]>(() => {
    const o = [{ data: "", label: defaultDriver ? `Default (${defaultDriver})` : "Default" }, ...driverOptions(drivers)];
    if (!cur.MESA || o.some((v) => v.data === cur.MESA)) return o;
    // MESA takes any prefix of a version (26.3.0-rc2 too); the ICD loader falls back to the default for others
    const known = drivers.some((d) => d.version.startsWith(cur.MESA as string));
    return [...o, { data: cur.MESA, label: known ? `Mesa ${cur.MESA}` : `${cur.MESA} (not installed)` }];
  }, [cur.MESA, drivers.map((d) => d.version).join(","), defaultDriver]);
  const mode = fsrMode(cur.FSR, cur.FSR_FG);
  const fsrOpts = useMemo<Opt[]>(() => [...FSR_MODES.map((m) => ({ data: m.data, label: m.label })),
    ...(mode === "custom" ? [{ data: "custom", label: `FSR=${cur.FSR ?? ""} FSR_FG=${cur.FSR_FG ?? ""}` }] : [])], [mode, cur.FSR, cur.FSR_FG]);

  const key = `${app.appid}-${rev}-${opts === undefined ? "reading" : "read"}-${drivers.length}`;
  const below = { layout: "below" as const, childrenContainerWidth: "max" as const, bottomSeparator: "none" as const };
  /** A choice's Details: what it does, when it applies, its note, and what it adds to the launch options. */
  const det = (title: string, does: string, note?: string, adds?: string | null): DetailsSpec => ({
    title, body: paragraphs([does, nextStart, note]),
    lines: adds ? [adds] : undefined, linesTitle: "Adds to launch options:",
  });
  const fgN = Number(cur.XESS_FG);
  const game = gi.data?.game ?? null;
  // OptiScaler in this game (DESIGN.md "With xess-xmx-linux"): the XeSS options it replaces are greyed out
  const optiEntry = steam && !!game?.opti_entry;
  const oi = useResource<OptiInfoRes>(optiEntry ? `opti-info:${app.appid}` : null, () => opti_info(app.appid));
  // the shared opti-info resource (OptiRows reloads it after its jobs) wins over game_info's flag, which is not reloaded
  const optiOn = steam && (oi.data?.ok ? ["installed", "partial"].includes(oi.data.opti?.state ?? "") : !!game?.opti_installed);
  const optiPlan = optiOn && oi.data?.ok && (oi.data.opti?.state === "installed" || oi.data.opti?.state === "partial") ? oi.data.opti?.launch ?? null : null;
  const optiWhy = optiOn ? "Set by OptiScaler for this game." : null;
  const xWhy = why ?? optiWhy;
  const xDisabled = disabled || optiOn;
  const lr = game ? lastRunLine(game.last_run) : null;
  const fgIssue = steam ? (game?.known_issues ?? []).find((i) => i.fg_crash) ?? null : null;
  const fsrIssue = steam ? (game?.known_issues ?? []).find((i) => i.fsr_risk || i.fg_crash) ?? null : null;
  /** A choice a known issue says crashes this game: asks first; false (and the dropdown is reset) when cancelled. */
  const risky = async (issue: GameIssue | null, what: string): Promise<boolean> => {
    if (!issue) return true;
    const ok = await confirm({ title: `${what} for ${app.name}?`, ok: "Use it anyway", destructive: true, effect: EFFECTS["game.fg"],
      text: paragraphs([`${issue.line}`, issue.detail, "If the game crashes, set it back to the game's own choice."]) });
    if (!ok) setRev((n) => n + 1);
    return ok;
  };
  const fsrNow = FSR_MODES.find((f) => f.data === mode);
  /** No libxess_fg.dll and no FSR route (FSR=xess / FSR_FG bring XeSS frame generation in, XESS_FG then sets its multi-frame). */
  const noFgLib = game?.has_fg === false && !cur.FSR && !cur.FSR_FG;

  const xessD = det("XeSS version", cur.XESS === "latest" ? "Intel's newest XeSS libraries from the package replace the game's older ones while it runs; the game's own files are back when it exits. For XeSS older than 2.0.2.68."
    : cur.XESS === "dp4a" ? "XeSS without Intel's extension (super resolution on the slower DP4a path, frame generation 2x only). For comparing, or ruling the fast path out."
    : "The game's own XeSS libraries, on the fast XMX cores through the patched driver.",
  "Needs the xess-xmx-linux hook in the game's Proton.", cur.XESS ? `XESS=${cur.XESS}` : "XESS=latest or XESS=dp4a");
  const fgD: DetailsSpec = {
    ...det("Frame generation", cur.XESS_FG ? `XeSS frame generation makes ${cur.XESS_FG}x, whatever the game's menu says. Turn frame generation on in the game and keep a frame limit on.${fgN > 4 ? " Experimental: beyond what Intel supports; 7x and 8x add latency." : ""}`
      : "The game's own frame generation choice.", "Needs XeSS frame generation 1.2 or newer in the game (else also \"Newer XeSS\" above).", cur.XESS_FG ? `XESS_FG=${cur.XESS_FG}` : "XESS_FG=2..4"),
    body: paragraphs([
      cur.XESS_FG ? `XeSS frame generation makes ${cur.XESS_FG}x, whatever the game's menu says. Turn frame generation on in the game and keep a frame limit on.${fgN > 4 ? " Experimental: beyond what Intel supports; 7x and 8x add latency." : ""}`
        : "The game's own frame generation choice.",
      FG_CRASH_LINE,
      fgIssue ? `${fgIssue.label}: ${fgIssue.line}` : null,
      noFgLib ? "This game has no XeSS frame generation library (libxess_fg.dll), so this setting has nothing to act on." : null,
      "A frame limit (Steam's, or gamescope's from the OXP3 frame-limit key) caps the generated frames too; exclusive fullscreen turns XeSS frame generation off.",
      nextStart, "Needs XeSS frame generation 1.2 or newer in the game (else also \"Newer XeSS\" above). OXP3 Deck never adds it by itself.",
    ]),
  };
  const expD: DetailsSpec = { title: "Show 5x–8x (experimental)", body: "Offers 5x to 8x in the frame generation list: the add-on raises the number inside Intel's library, which Intel does not support. 7x and 8x are not recommended (latency). Only changes the list; nothing is written." };
  const mesaD = det("Graphics driver", cur.MESA ? `This game uses the package's Mesa ${cur.MESA} driver.` : "The package's default driver (the XeSS tab sets it for all games).",
    "For a game that misbehaves on one driver only.", cur.MESA ? `MESA=${cur.MESA}` : "MESA=26.1 or 26.3");
  const vendorD = det("Compatibility mode", "Hides the Intel GPU's vendor id, so Mesa applies its own fixes for this game again. XeSS then runs on the slower DP4a path.",
    "Only for a game that needs Mesa's workaround.", "force_vk_vendor=-1");
  const dxArg = dx12Arg(app.appid);
  const dxKnown = dx12Known(app.appid);
  const dxOn = hasArg(text, dxArg);
  const dxD = det("Start in DirectX 12",
    `Starts the game with its DirectX 12 argument (${dxArg} after %command%, as the game's last argument); turning it off takes out only that argument, the rest of your text stays.${dxKnown ? " This game's XeSS frame generation option stays on only in DirectX 12 (owner report, The Witcher 3; with --launcher-skip the launcher's own choice is skipped too). With Set up games automatically on, OXP3 Deck adds it by itself once XeSS frame generation is set here." : ""}`,
    dxKnown ? "Frame generation also needs Xe Low Latency on in the game's graphics menu." : `Not every game knows ${dxArg}: a game that does not ignores it, or may not start. Turn it off if the game misbehaves.`,
    dxArg);
  const logD = det("Save XeSS logs", "Writes the add-on's, XeLL's and XeSS frame generation's logs into the game's prefix (C:\\igdext_trace.log and others), for a bug report.",
    "Leave it off otherwise.", "XESS_LOG=1");
  const fsrD = det("FSR → XeSS", fsrNow?.does ?? "Set by hand; pick one of the others to replace it.",
    `Needs xess-xmx-linux 20261104 or newer and its hook in the game's Proton. It replaces the game's FidelityFX DLL while the game runs: an anti-tamper check can make the game crash (xess-xmx-linux issue #42, a Capcom game). ${FG_CRASH_LINE}${fsrIssue ? ` ${fsrIssue.label}.` : ""}`,
    mode === "" ? "FSR=xess / FSR_FG=xess / FSR_FG=inject" : null);
  const typoD: DetailsSpec = { title: "Launch options typo", body: "The launch options have \"%command\" without its closing \"%\". Steam then passes everything as game arguments, so no setting reaches the game. \"Fix the typo\" changes it to %command% and leaves the rest as it is." };
  const optsD: DetailsSpec = { title: "Launch options", body: <Code>{text || "(none)"}</Code> };
  const pasteD: DetailsSpec = {
    title: "Paste these launch options",
    body: <>{steam ? "Steam did not return this game's launch options, so OXP3 Deck does not write them (that would replace yours). " : "OXP3 Deck does not change a non-Steam game's launch options. "}
      Pick the settings above, then copy the line with the button below and paste it into the game's Properties → Launch options.</>,
  };
  // the whole line to paste by hand (copyopts.ts): the refused write, the draft, or Steam's text with what the game needs
  const autoState = useAutoState();
  const autoLog = useAutoLog();
  const copyInput = {
    steam, text: opts, draft, wanted,
    suggest: steam ? game?.suggest ?? [] : [],
    done: autoLog.data?.[app.appid]?.done ?? [],
    autoOn: autoOnFor(autoState.data, app.appid), running: !!running,
    appid: app.appid, argsDone: autoLog.data?.[app.appid]?.argsDone ?? [],
    opti: optiPlan,
  };
  const xf = game?.last_run?.xefg;
  // the frame generation check (games.py xefg_check) in the last run's Details; without the log, how to turn it on
  const xefgLine = !game?.last_run ? null
    : xf ? (xf.refused ? `Frame generation check: refused (code ${xf.code}); see "Frame generation is refused". Log written ${when(xf.logged_at)}.`
      : `Frame generation check: XeSS frame generation's log shows no refusal (log written ${when(xf.logged_at)}).`)
    : game.has_fg !== false || cur.XESS_FG || cur.FSR || cur.FSR_FG
      ? "Frame generation check: no XeSS frame generation log (C:\\igdext_xefg.log). To see whether frame generation is refused, turn on Save XeSS logs (XESS_LOG=1) and start the game."
      : null;
  const lastD: DetailsSpec | null = game && lr ? {
    title: lr.label,
    body: paragraphs([lr.detail, xefgLine, game.last_run ? `Trace log: ${game.last_run.trace ? "yes (the add-on loaded)" : "no"} · patched driver self-test: ${game.last_run.canary ? "seen" : "not seen"} · kernel compile: ${game.last_run.compile_failed ? "failed" : "ok"}${game.last_run.xell_unsupported === true ? " · XeLL: this game's version is not supported" : game.last_run.xell_unsupported === false ? " · XeLL: supported" : ""}${game.last_run.logged_at ? ` · logged ${when(game.last_run.logged_at)}` : ""}` : null]),
    lines: [
      ...(game.dlls?.length ? game.dlls.map((d) => `${d.name} ${d.version ?? "(version unknown)"}${d.link ? " (a link left by XESS=latest)" : ""}`) : ["No XeSS files found in the game."]),
      ...(game.prefix ? [`prefix: ${game.prefix}`] : []),
    ],
    linesTitle: "Files:",
  } : null;

  return (
    <>
      {xs.data?.ok && !x?.installed && (
        <PanelSectionRow><Status ok={false} label="XeSS fast mode not installed" detail="These settings do nothing yet." /></PanelSectionRow>
      )}
      {steam && (
        <PanelSectionRow>
          <AutoSetupRows app={app} running={!!running} onWritten={(t) => { if (t !== null) { setOpts(t); setRev((n) => n + 1); } }} />
        </PanelSectionRow>
      )}
      {blocked && (
        <PanelSectionRow>
          <Status ok={false} red label="Launch options typo" detail="Blocks the settings below." details={typoD} />
          <ButtonItem layout="below" disabled={busy || opts === undefined} onClick={() => write(fixTypo(text), { id: "game.typo", label: "Launch options typo" })}
            description={explainWhen(nextStart, EFFECTS["game.typo"])}>
            Fix the typo
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <WithDetails details={xessD}>
          <DropdownItem key={`xess-${key}`} {...below} label={label("XeSS version", xessD)} menuLabel="XeSS version" disabled={xDisabled}
            rgOptions={xessOpts} selectedOption={cur.XESS ?? ""} onChange={(o) => change({ XESS: o.data || null }, "game.xess", "XeSS version")}
            description={explainWhen(cur.XESS === "latest" ? "Newer XeSS for older games." : cur.XESS === "dp4a" ? "For testing." : "Uses the game's XeSS.", EFFECTS["game.xess"], xWhy)} />
        </WithDetails>
        <WithDetails details={fgD}>
          <DropdownItem key={`fg-${key}-${experimental}`} {...below} label={label("Frame generation", fgD)} menuLabel="XeSS frame generation"
            disabled={xDisabled} rgOptions={fgOpts} selectedOption={cur.XESS_FG ?? ""}
            onChange={async (o) => {
              if (o.data && !(await risky(fgIssue, `Use XeSS frame generation ${o.data}x`))) return;
              change({ XESS_FG: o.data || null }, "game.fg", "Frame generation");
            }}
            description={explainWhen(fgIssue ? "Crashes this game: leave it on Game default."
              : noFgLib ? "This game has no XeSS frame generation."
              : cur.XESS_FG ? "Turn on frame gen in the game and set a frame limit." : "Uses the game's own choice. Can crash some games.", EFFECTS["game.fg"], xWhy)} />
        </WithDetails>
        <WithDetails details={expD}>
          <ToggleField label={label("Show 5x–8x (experimental)", expD)} checked={experimental} bottomSeparator="none"
            onChange={(v) => { setExperimental(v); remember.set("fgExperimental", v ? "1" : "0"); }}
            description={explain("Adds more choices above. Not supported by Intel.")} />
        </WithDetails>
        <WithDetails details={mesaD}>
          <DropdownItem key={`mesa-${key}`} {...below} label={label("Graphics driver", mesaD)} menuLabel="Graphics driver" disabled={disabled}
            rgOptions={mesaOpts} selectedOption={cur.MESA ?? ""} onChange={(o) => change({ MESA: o.data || null }, "game.mesa", "Graphics driver")}
            description={explainWhen("Only change if this game misbehaves.", EFFECTS["game.mesa"], why)} />
        </WithDetails>
        <WithDetails details={vendorD}>
          <ToggleField label={label("Compatibility mode", vendorD)} checked={cur.force_vk_vendor === "-1"} disabled={xDisabled} bottomSeparator="none"
            onChange={(v) => change({ force_vk_vendor: v ? "-1" : null }, "game.vendor", "Compatibility mode")}
            description={explainWhen("Only for games that need it; XeSS slows down.", EFFECTS["game.vendor"], xWhy)} />
        </WithDetails>
        <WithDetails details={dxD}>
          <ToggleField label={label("Start in DirectX 12", dxD)} checked={dxOn} disabled={disabled} bottomSeparator="none"
            onChange={(v) => write(setArg(text, dxArg, v), { id: "game.dx12", label: "Start in DirectX 12" })}
            description={explainWhen(dxKnown ? "This game's frame generation needs DirectX 12." : "Only for games that know it.", EFFECTS["game.dx12"], why)} />
        </WithDetails>
        <WithDetails details={logD}>
          <ToggleField label={label("Save XeSS logs", logD)} checked={!!cur.XESS_LOG && cur.XESS_LOG !== "0"} disabled={disabled} bottomSeparator="none"
            onChange={(v) => change({ XESS_LOG: v ? "1" : null }, "game.log", "Save XeSS logs")}
            description={explainWhen("For bug reports; leave off otherwise.", EFFECTS["game.log"], why)} />
        </WithDetails>
        {showFsr && (
          <WithDetails details={fsrD}>
            <DropdownItem key={`fsr-${key}`} {...below} label={label("FSR → XeSS", fsrD)} menuLabel="FSR on XeSS" disabled={xDisabled}
              rgOptions={fsrOpts} selectedOption={mode}
              onChange={async (o) => {
                const m = FSR_MODES.find((f) => f.data === o.data);
                if (!m) return;
                if (m.data && !(await risky(fsrIssue, m.label))) return;
                change(m.set, "game.fsr", "FSR → XeSS");
              }}
              description={explainWhen(fsrIssue ? "Can crash this game: leave it on the game's own." : fsrNow?.line ?? "Set by hand.", EFFECTS["game.fsr"], xWhy)} />
          </WithDetails>
        )}
        {busy && <Status ok={null} label="Saving…" />}
        {saved && !err && <Status ok label="Saved" detail={nextStart} />}
        <Pending ids={["game.xess", "game.fg", "game.mesa", "game.vendor", "game.dx12", "game.log", "game.fsr", "game.typo"]} appid={app.appid} />
        <Problem what="Launch options" error={err} />
        {writable ? (
          !quick && <Status ok={null} label="Launch options" detail={text ? "Open Details to see them." : "None"} details={optsD} />
        ) : opts === undefined ? (
          <Status ok={null} label="Reading the launch options…" />
        ) : (
          <>
            <Status ok={null} label="Paste these launch options" detail="OXP3 Deck can't write them for this game." details={pasteD} />
            {steam && <ButtonItem layout="below" onClick={read} description={explain("Asks Steam again.")}>Read again</ButtonItem>}
          </>
        )}
        <CopyLaunchRows input={copyInput} game={app.name} />
      </PanelSectionRow>
      {optiEntry && (
        <PanelSectionRow>
          <OptiRows app={app} quick={quick} running={!!running} game={game} xessInstalled={xs.data?.ok ? !!x?.installed : null}
            onWritten={(t) => { if (t !== null) { setOpts(t); setRev((n) => n + 1); } }} />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <Problem what="Game check" error={gi.data && !gi.data.ok ? gi.data.error : null} />
        {game && <Status ok={game.compat_tool_shimmed} label={`Proton: ${toolName(game)}`} detail={protonShort(game)}
          details={{ title: `Proton: ${toolName(game)}`, body: protonLine(game) }} />}
        {steam && (game?.known_issues ?? []).map((i) => (
          <Status key={`issue-${i.id}`} ok={false} red={i.fg_crash && !!(cur.XESS_FG || cur.FSR || cur.FSR_FG)} label={i.label} detail={i.line}
            details={{ title: i.label, body: paragraphs([optiOn ? `Without OptiScaler: ${i.detail}` : i.detail, `Source: ${i.source}.`]) }} />
        ))}
        {steam && cur.XESS_FG && noFgLib && (
          <Status ok={false} label="No XeSS frame generation in this game" detail="Frame generation here has nothing to act on."
            details={{ title: "No XeSS frame generation in this game", body: paragraphs([
              `The launch options set XESS_FG=${cur.XESS_FG}, but the game's folder has no libxess_fg.dll: XeSS frame generation only changes a game that ships it (XeSS version: Latest replaces only files that are there).`,
              "Set Frame generation back to Game default. For a game with FSR 3.1+, FSR → XeSS can bring XeSS frame generation in, but it replaces the game's FidelityFX DLL and can crash a game with anti-tamper."]) }} />
        )}
        {steam && (game?.checks ?? []).map((c) => (
          <Status key={`check-${c.id}`} ok={false} label={c.label} detail={c.line} details={{
            title: c.label,
            body: paragraphs([c.detail, c.at ? `The log was written ${when(c.at)}. If that is before your last start of the game, it is from an older run.` : null]),
            lines: c.lines?.length ? c.lines : undefined, linesTitle: "The log says:",
          }} />
        ))}
        {(game?.advice ?? []).map((a, i) => (
          <Note key={i} label={i === 0 ? "Tip" : undefined} details={a.length > 80 ? { title: "Tip", body: a } : undefined}>{firstSentence(a)}</Note>
        ))}
        {lr && <Status ok={lr.ok} label={lr.label} detail={lr.line} details={lastD} />}
      </PanelSectionRow>
    </>
  );
};
