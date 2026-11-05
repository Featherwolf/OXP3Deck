// The texts of the other power programs OXP3 Deck finds (DESIGN.md "Conflict rows", "Fix for me, Undo"): a friendly
// name, the one line a row shows up front, its Details, and the Fix for me / Undo dialogs. Framework-free so node can
// test it (tests/js/conflicts.test.mjs); ConflictRow.tsx turns these into rows.
import type { EffectSpec } from "./effects";
import type { PowerConflict, PowerFixed } from "./types";

/** The systemd units Fix for me may stop and disable, per conflict id: power.py's FIXABLE, the same whitelist. */
export const FIXABLE: Record<string, string[]> = {
  powerstation: ["powerstation.service"],
  thermald: ["thermald.service"],
  "oxp3-tdp-sync": ["oxp3-tdp-sync.service"],
  "onex3-tdp": ["onex3-tdp.service"],
  ppd: ["power-profiles-daemon.service"],
  tuned: ["tuned-ppd.service", "tuned.service"],
  intel_lpmd: ["intel_lpmd.service"],
};

/** The FIXABLE units that D-Bus or another unit can start again, so Fix for me also masks them: power.py's MASKABLE. */
export const MASKABLE: ReadonlySet<string> = new Set([
  "power-profiles-daemon.service", "tuned-ppd.service", "tuned.service", "thermald.service", "intel_lpmd.service",
]);

/** True when a record says OXP3 Deck masked one of its units (older records never did). */
const maskedByUs = (rec: Pick<PowerFixed, "units"> | null | undefined): boolean =>
  !!rec?.units?.some((u) => u.was_masked === false && MASKABLE.has(u.unit));

/** The conflicts that take energy preference and CPU boost, not the power limits. */
const CPU = new Set(["ppd", "tuned", "intel_lpmd"]);

type Text = { name: string; line: string; body: string[]; tech: string };

const LIMITS = "Also changes power limits, so power control is paused.";
const CPU_LINE = "Controls energy preference and CPU boost.";

const TEXTS: Record<string, Text> = {
  ppd: {
    name: "Power Profiles", line: CPU_LINE,
    body: [
      "The desktop's power mode service. It sets the CPU's energy preference from the power mode you pick in Desktop Mode, so OXP3 Deck leaves energy preference and CPU boost alone while it runs. Power limits and GPU speed still work.",
      "Turning it off: the power mode switch in Desktop Mode (KDE's power profiles) stops working, and so does profile switching by Steam or CachyOS's game launcher (game-performance): games run without its profile.",
    ],
    tech: "power-profiles-daemon.service; it writes EPP/EPB and platform_profile.",
  },
  tuned: {
    name: "TuneD", line: CPU_LINE,
    body: [
      "A system tuning service; tuned-ppd stands in for the desktop's power mode service. It sets the CPU's energy preference, so OXP3 Deck leaves energy preference and CPU boost alone while it runs.",
      "Turning it off: the power mode switch in Desktop Mode stops working. Both parts are turned off: TuneD alone keeps its profile.",
    ],
    tech: "tuned-ppd.service and tuned.service.",
  },
  intel_lpmd: {
    name: "Intel low-power daemon", line: "Controls energy preference and parks CPU cores.",
    body: [
      "Intel's low-power service. CachyOS turns it on for this CPU. It changes the energy preference and parks CPU cores during light work, so OXP3 Deck leaves energy preference and CPU boost alone while it runs. It does not touch the power limits.",
      "Turning it off: light tasks and video use a bit more battery; games are fine.",
    ],
    tech: "intel_lpmd.service; it writes EPP and may lower intel_pstate/max_perf_pct.",
  },
  thermald: {
    name: "Thermal daemon", line: "Lowers the power limit on its own, so power control is paused.",
    body: [
      "Intel's thermal service. On this CPU it rewrites the sustained power limit within seconds, so OXP3 Deck cannot hold yours while it runs.",
      "Turning it off: the CPU's own heat limit and the fan still protect the device; the case may get warmer at high power.",
    ],
    tech: "thermald.service; it rewrites RAPL PL1.",
  },
  powerstation: {
    name: "PowerStation", line: LIMITS,
    body: [
      "A power service on Bazzite. It is what makes Steam's own TDP slider work, and it sets the same power limits as OXP3 Deck.",
      "Turning it off: Steam's TDP slider does nothing; OXP3 Deck's sliders replace it. Bazzite may turn it back on after a system update; OXP3 Deck will tell you.",
    ],
    tech: "powerstation.service.",
  },
  "oxp3-tdp-sync": {
    name: "TDP sync script", line: LIMITS,
    body: [
      "A community script that copies one power limit into the other every 2 seconds. OXP3 Deck already sets both, so it is not needed.",
    ],
    tech: "oxp3-tdp-sync.service; it copies the MMIO PL1 into MSR.",
  },
  "onex3-tdp": {
    name: "onex3-tdp", line: LIMITS,
    body: ["Another script that sets the power limits."],
    tech: "onex3-tdp.service.",
  },
  simpledeckytdp: {
    name: "SimpleDeckyTDP", line: LIMITS,
    body: [
      "Another Decky plugin that sets the same power limits.",
      "Import its profiles first (Power tab → Import from SimpleDeckyTDP), then in Decky → Settings → Plugins disable or uninstall it. OXP3 Deck does not change another plugin.",
    ],
    tech: "Decky plugin SimpleDeckyTDP.",
  },
  powercontrol: {
    name: "", line: LIMITS,
    body: ["Another Decky plugin that sets the same power limits.", "In Decky → Settings → Plugins, disable or uninstall it. OXP3 Deck does not change another plugin."],
    tech: "Decky plugin PowerControl / PowerTools.",
  },
  hhd: {
    name: "Handheld Daemon", line: "Its TDP setting also changes power limits.",
    body: [
      "Handheld Daemon's TDP control sets the same power limits.",
      "Turn off TDP in Handheld Daemon's settings, then tap \"I've handled it\". It may run the controller, so OXP3 Deck does not stop it.",
    ],
    tech: "hhd@<user>.service / hhd.service / hhd_local@<user>.service.",
  },
  "steamos-remote": {
    name: "Steam's TDP slider", line: "Steam's TDP slider can change these limits.",
    body: [
      "Steam's own TDP slider can change the power limits through a system file.",
      "Open Quick Access → Performance and turn off \"TDP limit\", then tap \"I've handled it\".",
    ],
    tech: "a steamos-manager remote with TdpLimit1 (/etc or /usr/share/steamos-manager/remotes.d).",
  },
  unknown: {
    name: "Service check", line: "Couldn't check other services.",
    body: ["OXP3 Deck could not list the running services, so it cannot tell whether another program changes these settings. Tap \"Check again\"."],
    tech: "systemctl list-units failed.",
  },
};

const known = (id: string): Text | undefined => (Object.prototype.hasOwnProperty.call(TEXTS, id) ? TEXTS[id] : undefined);

/** The friendly name of a conflict id (`fallback`: the backend's row name, for a plugin name or an unknown id). */
export const friendlyName = (id: string, fallback?: string | null): string => known(id)?.name || fallback || id;

/** True when Fix for me exists for this id at all (the row's fix_units say whether it is offered now). */
export const fixable = (id: string): boolean => Object.prototype.hasOwnProperty.call(FIXABLE, id);

/** True for a conflict that takes energy preference and CPU boost (not the power limits). */
export const isCpu = (id: string): boolean => CPU.has(id);

/** What the conflict takes away from OXP3 Deck, for the Undo text. */
export const controls = (id: string): string => (CPU.has(id) ? "energy preference and CPU boost" : "the power limits");

const short = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 80 ? t : `${t.slice(0, 79).replace(/\s+\S*$/, "")}…`;
};

/** Who most likely started a unit OXP3 Deck turned off. `fixed`: its record; a masked unit cannot be started by
 * systemd, so running again means it did not stop or was started outside systemd. */
export const cameBackText = (id: string, fixed?: Pick<PowerFixed, "units"> | null): string =>
  maskedByUs(fixed) ? "It's running even though OXP3 Deck masked it."
    : id === "ppd" || id === "tuned" ? "It started again, likely from the desktop's power mode or a game launcher."
    : id === "powerstation" ? "It's back on, likely after a Bazzite update."
    : "It started again.";

/** The one line a conflict row shows up front. */
export const oneLine = (row: Pick<PowerConflict, "id" | "why"> & { fixed?: PowerFixed | null }): string => {
  if (row.fixed?.came_back) return cameBackText(row.id, row.fixed);
  const t = known(row.id);
  if (t) return t.line;
  const why = (row.why ?? "").replace(/^[^:]*:\s*/, "");
  return short(why ? why[0].toUpperCase() + why.slice(1) : "Also changes these settings.");
};

/** "Locked by <name>." under energy preference and CPU boost. */
export const lockedLine = (names: string[]): string => `Locked by ${names.join(" and ") || "another program"}.`;

export type ExplainBody = { title: string; body: string[]; lines: string[]; linesTitle: string };

/** A conflict's Details: what it is, what turning it off costs here, how to fix it, then the manual way. */
export const explainBody = (row: Pick<PowerConflict, "id" | "name" | "why" | "fix"> & Partial<Pick<PowerConflict, "fix_units" | "fixed">>): ExplainBody => {
  const t = known(row.id);
  const name = friendlyName(row.id, row.name);
  const body = t ? [...t.body] : [row.why ? row.why[0].toUpperCase() + row.why.slice(1) + "." : "It changes the same settings as OXP3 Deck."];
  if (row.fixed?.came_back) {
    body.unshift(maskedByUs(row.fixed)
      ? `${cameBackText(row.id, row.fixed)} It did not stop, or something started it outside systemd. A restart stops it; "Undo" unmasks it and turns it back on.`
      : `${cameBackText(row.id, row.fixed)} OXP3 Deck turned it off earlier; "Fix again" turns it off again, "Undo" turns it back on for good.`);
  }
  if (row.fix_units?.length) {
    body.push((row.fix_units.some((u) => MASKABLE.has(u))
      ? "\"Fix for me\" turns it off after you confirm and masks it, so nothing can start it again; \"Undo\" unmasks it and turns it back on."
      : "\"Fix for me\" turns it off after you confirm, and \"Undo\" turns it back on.") + " Nothing is uninstalled.");
  }
  if (t?.tech) body.push(`Technical: ${t.tech}`);
  return { title: name, body, lines: manualCommand(row.fix), linesTitle: "Do it yourself:" };
};

/** The command of a "sudo …" fix text, without the reason after it; [] for prose the body already says. */
const manualCommand = (fix: string | null | undefined): string[] => {
  if (!fix || !fix.startsWith("sudo ")) return [];
  const cut = [": ", ". ", " ("].map((m) => fix.indexOf(m)).filter((i) => i > 0);
  return [(cut.length ? fix.slice(0, Math.min(...cut)) : fix).replace(/\.$/, "")];
};

/** One command Fix for me runs (the backend leaves out a disable for a unit that is not enabled, a stop for one not
 * running, and masks only MASKABLE units: the row's fix_plan says which, when it could tell). */
const cmd = (action: string, units: string[]) => `systemctl --no-ask-password ${action} -- ${units.join(" ")}`;

export type DialogText = { title: string; text: string; lines: string[]; linesTitle: string; ok: string; effect: EffectSpec };

/** Per id: the dialog title, who is turned off, and what it costs (after the generated "OXP3 Deck will …" lead). */
type FixText = { title: string; who: string; them?: boolean; rest: string };
const FIX_TEXT: Record<string, FixText> = {
  ppd: {
    title: "Turn off Power Profiles?", who: "power-profiles-daemon",
    rest: "What stops working: the power mode switch in Desktop Mode (KDE's power profiles) and profile switching by Steam or CachyOS's game launcher (game-performance).",
  },
  tuned: {
    title: "Turn off TuneD?", who: "TuneD (tuned-ppd and tuned)", them: true,
    rest: "What stops working: the power mode switch in Desktop Mode (KDE's power profiles), profile switching by Steam or a game launcher, and TuneD's own tuning.",
  },
  intel_lpmd: {
    title: "Turn off Intel's low-power daemon?", who: "intel_lpmd",
    rest: "Light tasks and video may use a bit more battery; games are not affected.",
  },
  thermald: {
    title: "Turn off the thermal daemon?", who: "thermald",
    rest: "It lowers the power limit on its own within seconds, so OXP3 Deck cannot hold yours. The CPU's own heat limit and the fan still protect the device; the case may get warmer at high power.",
  },
  powerstation: {
    title: "Turn off PowerStation?", who: "PowerStation",
    rest: "Steam's own TDP slider stops working; OXP3 Deck's replaces it. On Bazzite, a system update may turn it back on; OXP3 Deck will tell you.",
  },
};

/** "OXP3 Deck will stop X and keep it from starting at boot." for what the plan really does; with `mask`, also
 * that it is masked so nothing can start it again. */
const lead = (who: string, them: boolean, disable: boolean, stop: boolean, mask: boolean): string => {
  const it = them ? "them" : "it";
  if (mask) {
    const acts = [...(stop ? [`stop ${who}`] : []), ...(disable ? [`keep ${it} from starting at boot`] : [])];
    const all = acts.length ? `${acts.join(", ")} and mask ${it}` : `mask ${who}`;
    return `OXP3 Deck will ${all}: while masked, nothing can start ${it} again, not the desktop, a game launcher or another service.`;
  }
  if (stop && disable) return `OXP3 Deck will stop ${who} and keep ${it} from starting at boot.`;
  if (stop) return `OXP3 Deck will stop ${who}. ${them ? "They are" : "It is"} not set to start at boot, so nothing else changes.`;
  return `OXP3 Deck will keep ${who} from starting at boot. ${them ? "They are" : "It is"} not running now.`;
};

/** The Fix for me (and Fix again) confirmation: what changes in plain words, the exact commands as lines.
 * `powerOn`: power control is on, so OXP3 Deck can set energy preference and CPU boost afterwards. */
export const fixConfirm = (row: Pick<PowerConflict, "id" | "name"> & Partial<Pick<PowerConflict, "fix_units" | "fix_plan">>,
  powerOn?: boolean): DialogText => {
  const name = friendlyName(row.id, row.name);
  const units = row.fix_units?.length ? row.fix_units : FIXABLE[row.id] ?? [];
  const plan = row.fix_plan && (row.fix_plan.disable.length || row.fix_plan.stop.length || row.fix_plan.mask?.length)
    ? row.fix_plan : null;
  const disable = plan ? plan.disable : units;
  const stop = plan ? plan.stop : units;
  const mask = plan?.mask ?? units.filter((u) => MASKABLE.has(u));
  const t: FixText = FIX_TEXT[row.id] ?? { title: `Turn off ${name}?`, who: name, rest: "OXP3 Deck already sets these limits." };
  const after = CPU.has(row.id) && powerOn ? " Then OXP3 Deck can set energy preference and CPU boost." : "";
  const kept = FIX_TEXT[row.id] ? "Nothing is uninstalled." : "Nothing is deleted.";
  return {
    title: t.title,
    text: `${lead(t.who, !!t.them, disable.length > 0, stop.length > 0, mask.length > 0)} ${kept}${after} ${t.rest} ${mask.length ? `Undo unmasks ${t.them ? "them" : "it"} and turns ${t.them ? "them" : "it"} back on as before.` : "Undo turns it back on."}`,
    lines: [...(stop.length ? [cmd("stop", stop)] : []), ...(disable.length ? [cmd("disable", disable)] : []),
      ...(mask.length ? [cmd("mask", mask)] : [])],
    linesTitle: "Commands (run as root):",
    ok: "Turn it off",
    effect: "now",
  };
};

/** The Undo confirmation: unmasks what OXP3 Deck masked, then turns on exactly what it turned off. `date`: the
 * record's time, formatted. */
export const undoConfirm = (rec: Pick<PowerFixed, "id" | "name" | "units">, date: string): DialogText => {
  const name = friendlyName(rec.id, rec.name);
  const en = rec.units.filter((u) => u.was_enabled === "enabled").map((u) => u.unit);
  const st = rec.units.filter((u) => u.was_active).map((u) => u.unit);
  const um = rec.units.filter((u) => u.was_masked === false && MASKABLE.has(u.unit)).map((u) => u.unit);
  const lines = [...(um.length ? [cmd("unmask", um)] : []), ...(en.length ? [cmd("enable", en)] : []),
    ...(st.length ? [cmd("start", st)] : [])];
  return {
    title: `Turn ${name} back on?`,
    text: `OXP3 Deck ${um.length ? "unmasks and " : ""}turns back on what it turned off${date ? ` (${date})` : ""}. Then ${name} controls ${controls(rec.id)} again.${lines.length ? "" : " Nothing needs to run: it was neither on at boot nor running."}`,
    lines,
    linesTitle: "Commands (run as root):",
    ok: "Turn it back on",
    effect: "now",
  };
};

/** The Undo row's Details: the units as they were before OXP3 Deck changed them. */
export const fixedLines = (rec: Pick<PowerFixed, "units">): string[] =>
  rec.units.map((u) => `${u.unit}: was ${u.was_enabled || "unknown"}${u.was_active ? ", running" : ", not running"}${u.was_masked === false ? ", not masked (OXP3 Deck masked it)" : ""}`);
