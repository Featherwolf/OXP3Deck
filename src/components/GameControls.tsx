// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// Based on ClawDeck's per-game tab (src/tabs/PerGame.tsx).
// The option descriptions follow xess-xmx-linux's docs/launch-options.md (Copyright (c) 2026 HHHHanasak1), partly
// in its words; the project's MIT licence is in THIRD_PARTY_NOTICES.md.
// One game's xess-xmx-linux options, written straight into its Steam launch options (before %command%), plus what
// the backend found about the game (its XeSS DLLs, its Proton, the last run's logs).
import { ButtonItem, DropdownItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { FC, useEffect, useMemo, useRef, useState } from "react";

import { game_info, xess_state } from "../backend";
import { driverPrefix, fixTypo, fsrSupported, managed, ManagedKey, parse, setManaged } from "../launchopts";
import { getLaunchOptions, isSteamApp, RunningApp, setLaunchOptions } from "../steam";
import { EFFECTS } from "../effects";
import { notePending, useResource } from "../store";
import type { GameInfo, GameInfoRes, XessDriver, XessStateRes } from "../types";
import { remember, when } from "../util";
import { firstSentence } from "../text";
import { DetailsSpec, paragraphs } from "./confirm";
import { AutoLaunchRows } from "./AutoLaunch";
import { Pending } from "./Effect";
import { Code, explain, explainWhen, label, Note, Problem, Status, WithDetails } from "./Hint";

type Opt = { data: string; label: string };

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
  const [saved, setSaved] = useState(false);
  const [rev, setRev] = useState(0);              // remounts the dropdowns when the value is not what was picked
  const [experimental, setExperimental] = useState(() => remember.get("fgExperimental") === "1");

  const seq = useRef(0);
  const read = async () => {
    const mine = ++seq.current;   // a read for a game the panel has left since is dropped
    setOpts(undefined);
    const o = steam ? await getLaunchOptions(app.appid) : null;
    if (mine !== seq.current) return;
    setOpts(o);
    setRev((n) => n + 1);
  };
  useEffect(() => { setErr(null); setSaved(false); setDraft(""); read(); }, [app.appid]);

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
    // while the game runs, the pending row ("Restart … to apply") says it instead of "Saved"
    setSaved(r.ok && !(running && what));
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
  const lr = game ? lastRunLine(game.last_run) : null;
  const fsrNow = FSR_MODES.find((f) => f.data === mode);

  const xessD = det("XeSS version", cur.XESS === "latest" ? "Intel's newest XeSS libraries from the package replace the game's older ones while it runs; the game's own files are back when it exits. For XeSS older than 2.0.2.68."
    : cur.XESS === "dp4a" ? "XeSS without Intel's extension (super resolution on the slower DP4a path, frame generation 2x only). For comparing, or ruling the fast path out."
    : "The game's own XeSS libraries, on the fast XMX cores through the patched driver.",
  "Needs the xess-xmx-linux hook in the game's Proton.", cur.XESS ? `XESS=${cur.XESS}` : "XESS=latest or XESS=dp4a");
  const fgD = det("Frame generation", cur.XESS_FG ? `XeSS frame generation makes ${cur.XESS_FG}x, whatever the game's menu says. Turn frame generation on in the game and keep a frame limit on.${fgN > 4 ? " Experimental: beyond what Intel supports; 7x and 8x add latency." : ""}`
    : "The game's own frame generation choice.", "Needs XeSS frame generation 1.2 or newer in the game (else also \"Newer XeSS\" above).", cur.XESS_FG ? `XESS_FG=${cur.XESS_FG}` : "XESS_FG=2..4");
  const expD: DetailsSpec = { title: "Show 5x–8x (experimental)", body: "Offers 5x to 8x in the frame generation list: the add-on raises the number inside Intel's library, which Intel does not support. 7x and 8x are not recommended (latency). Only changes the list; nothing is written." };
  const mesaD = det("Graphics driver", cur.MESA ? `This game uses the package's Mesa ${cur.MESA} driver.` : "The package's default driver (the XeSS tab sets it for all games).",
    "For a game that misbehaves on one driver only.", cur.MESA ? `MESA=${cur.MESA}` : "MESA=26.1 or 26.3");
  const vendorD = det("Compatibility mode", "Hides the Intel GPU's vendor id, so Mesa applies its own fixes for this game again. XeSS then runs on the slower DP4a path.",
    "Only for a game that needs Mesa's workaround.", "force_vk_vendor=-1");
  const logD = det("Save XeSS logs", "Writes the add-on's, XeLL's and XeSS frame generation's logs into the game's prefix (C:\\igdext_trace.log and others), for a bug report.",
    "Leave it off otherwise.", "XESS_LOG=1");
  const fsrD = det("FSR → XeSS", fsrNow?.does ?? "Set by hand; pick one of the others to replace it.",
    "Needs xess-xmx-linux 20261104 or newer and its hook in the game's Proton.", mode === "" ? "FSR=xess / FSR_FG=xess / FSR_FG=inject" : null);
  const typoD: DetailsSpec = { title: "Launch options typo", body: "The launch options have \"%command\" without its closing \"%\". Steam then passes everything as game arguments, so no setting reaches the game. \"Fix the typo\" changes it to %command% and leaves the rest as it is." };
  const optsD: DetailsSpec = { title: "Launch options", body: <Code>{text || "(none)"}</Code> };
  const pasteD: DetailsSpec = {
    title: "Paste these launch options",
    body: <>{steam ? "Steam did not return this game's launch options, so OXP3 Deck does not write them (that would replace yours). " : "OXP3 Deck does not change a non-Steam game's launch options. "}
      Paste this into the game's Properties → Launch options{text ? ":" : " once you picked something above."}
      {text && <><br /><Code>{text}</Code></>}</>,
  };
  const lastD: DetailsSpec | null = game && lr ? {
    title: lr.label,
    body: paragraphs([lr.detail, game.last_run ? `Trace log: ${game.last_run.trace ? "yes (the add-on loaded)" : "no"} · patched driver self-test: ${game.last_run.canary ? "seen" : "not seen"} · kernel compile: ${game.last_run.compile_failed ? "failed" : "ok"}${game.last_run.xell_unsupported === true ? " · XeLL: this game's version is not supported" : game.last_run.xell_unsupported === false ? " · XeLL: supported" : ""}${game.last_run.logged_at ? ` · logged ${when(game.last_run.logged_at)}` : ""}` : null]),
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
          <DropdownItem key={`xess-${key}`} {...below} label={label("XeSS version", xessD)} menuLabel="XeSS version" disabled={disabled}
            rgOptions={xessOpts} selectedOption={cur.XESS ?? ""} onChange={(o) => change({ XESS: o.data || null }, "game.xess", "XeSS version")}
            description={explainWhen(cur.XESS === "latest" ? "Newer XeSS for older games." : cur.XESS === "dp4a" ? "For testing." : "Uses the game's XeSS.", EFFECTS["game.xess"], why)} />
        </WithDetails>
        <WithDetails details={fgD}>
          <DropdownItem key={`fg-${key}-${experimental}`} {...below} label={label("Frame generation", fgD)} menuLabel="XeSS frame generation"
            disabled={disabled} rgOptions={fgOpts} selectedOption={cur.XESS_FG ?? ""} onChange={(o) => change({ XESS_FG: o.data || null }, "game.fg", "Frame generation")}
            description={explainWhen(cur.XESS_FG ? "Turn on frame gen in the game and set a frame limit." : "Uses the game's own choice.", EFFECTS["game.fg"], why)} />
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
          <ToggleField label={label("Compatibility mode", vendorD)} checked={cur.force_vk_vendor === "-1"} disabled={disabled} bottomSeparator="none"
            onChange={(v) => change({ force_vk_vendor: v ? "-1" : null }, "game.vendor", "Compatibility mode")}
            description={explainWhen("Only for games that need it; XeSS slows down.", EFFECTS["game.vendor"], why)} />
        </WithDetails>
        <WithDetails details={logD}>
          <ToggleField label={label("Save XeSS logs", logD)} checked={!!cur.XESS_LOG && cur.XESS_LOG !== "0"} disabled={disabled} bottomSeparator="none"
            onChange={(v) => change({ XESS_LOG: v ? "1" : null }, "game.log", "Save XeSS logs")}
            description={explainWhen("For bug reports; leave off otherwise.", EFFECTS["game.log"], why)} />
        </WithDetails>
        {showFsr && (
          <WithDetails details={fsrD}>
            <DropdownItem key={`fsr-${key}`} {...below} label={label("FSR → XeSS", fsrD)} menuLabel="FSR on XeSS" disabled={disabled}
              rgOptions={fsrOpts} selectedOption={mode}
              onChange={(o) => { const m = FSR_MODES.find((f) => f.data === o.data); if (m) change(m.set, "game.fsr", "FSR → XeSS"); }}
              description={explainWhen(fsrNow?.line ?? "Set by hand.", EFFECTS["game.fsr"], why)} />
          </WithDetails>
        )}
        {busy && <Status ok={null} label="Saving…" />}
        {saved && !err && <Status ok label="Saved" detail={nextStart} />}
        <Pending ids={["game.xess", "game.fg", "game.mesa", "game.vendor", "game.log", "game.fsr", "game.typo"]} appid={app.appid} />
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
      </PanelSectionRow>
      {steam && (
        <PanelSectionRow>
          <AutoLaunchRows app={app} running={!!running} onWritten={(t) => { if (t !== null) { setOpts(t); setRev((n) => n + 1); } }} />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <Problem what="Game check" error={gi.data && !gi.data.ok ? gi.data.error : null} />
        {game && <Status ok={game.compat_tool_shimmed} label={`Proton: ${toolName(game)}`} detail={protonShort(game)}
          details={{ title: `Proton: ${toolName(game)}`, body: protonLine(game) }} />}
        {(game?.advice ?? []).map((a, i) => (
          <Note key={i} label={i === 0 ? "Tip" : undefined} details={a.length > 80 ? { title: "Tip", body: a } : undefined}>{firstSentence(a)}</Note>
        ))}
        {lr && <Status ok={lr.ok} label={lr.label} detail={lr.line} details={lastD} />}
      </PanelSectionRow>
    </>
  );
};
