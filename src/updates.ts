// The daily update checks (ROADMAP T1-9 + C-5, DESIGN.md "Daily update checks"): which of the backend's answers may
// fill the "manual:" update caches, and the texts of the notices (the bundled oxp3-tool, helpers to apply again, a new
// OXP3 Deck) and of the switch. Nothing installs on its own: every notice is a button. Framework-free
// (tests/js/updates.test.mjs).
import type { Oxp3Fix, Oxp3Install, Oxp3Status, Oxp3UpdateCheck, UpdatesAuto, XessSummary, XessUpdateCheck } from "./types";

/** The caches the Updates tab's and XeSS group's "Check for an update" buttons fill. */
export const CHECK_KEYS = { oxp3: "manual:oxp3-check", xess: "manual:xess-check" } as const;

const nums = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
/** a > b for dotted versions (util.cmpVersion's rule; util imports Decky's toaster, which node cannot load). */
const newer = (a: string, b: string): boolean => {
  const pa = nums(a), pb = nums(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
};

/**
 * The automatic oxp3-tool check to put in its cache, or null: one that worked, made for the oxp3-tool installed now
 * (not one from before an update), and newer than what the cache holds (`cachedAt`, seconds; a tap's check later
 * than it wins).
 */
export const oxp3Fill = (u: UpdatesAuto | null | undefined, i: Oxp3Install | null | undefined, cachedAt?: number | null): Oxp3UpdateCheck | null => {
  const c = u?.oxp3;
  if (!c?.ok || !i || c.installed !== i.version || c.bundled !== i.bundled_version) return null;
  return cachedAt != null && cachedAt >= c.checked_at ? null : c;
};

/** The automatic XeSS check to put in its cache, or null (the same rules; `x` is the overview's XeSS summary). */
export const xessFill = (u: UpdatesAuto | null | undefined, x: XessSummary | null | undefined, cachedAt?: number | null): XessUpdateCheck | null => {
  const c = u?.xess;
  if (!c?.ok || !x || c.installed !== (x.installed ? x.version : null)) return null;
  return cachedAt != null && cachedAt >= c.checked_at ? null : c;
};

/** Device fixes' "Update available": the plugin's copy is newer, or a check found one on GitHub for this install. */
export const oxp3UpdateFlag = (i: Oxp3Install | null | undefined, check: Oxp3UpdateCheck | null | undefined, bundledNewer: boolean): boolean =>
  bundledNewer || (!!check?.ok && !!check.update && !!i?.installed && check.installed === i.version);

export type Notice = { label: string; line: string; button: string; title: string; body: string };

/** "oxp3-tool 0.4.4 bundled: Install": the copy in this plugin is newer than the installed one (an install, a job). */
export const bundledNotice = (i: Oxp3Install | null | undefined): Notice | null => {
  if (!i?.installed || !i.version || !i.bundled_version || !newer(i.bundled_version, i.version)) return null;
  return {
    label: `oxp3-tool ${i.bundled_version} bundled`, line: `Installed: ${i.version}. Takes a few seconds.`, button: "Install",
    title: `Install oxp3-tool ${i.bundled_version}`,
    body: `This OXP3 Deck carries oxp3-tool ${i.bundled_version}; ${i.version} is installed. Installing it changes no fix. Helpers it installed (like the Xbox key's) may need Apply again afterwards: Device fixes says which. Asks first.`,
  };
};

/** The toast after the bundled install worked. */
export const installedToast = (version: string | null) => ({
  title: `oxp3-tool ${version ?? ""} installed`.replace("  ", " "),
  body: "Helpers like the Xbox key may need Apply again: see Device fixes.",
});

const OLD_HELPER = /older oxp3-tool/i;

/** Applied fixes whose helper oxp3-tool's status says is from an older oxp3-tool (fixes.py: "... older oxp3-tool"). */
export const staleHelpers = (st: Oxp3Status | null | undefined): Oxp3Fix[] =>
  (st?.fixes ?? []).filter((f) => f.state !== "n/a" && f.state !== "reverting" && (f.notes ?? []).some((n) => OLD_HELPER.test(n)));

export const helpersNotice = (fixes: Oxp3Fix[]): Notice | null => {
  if (!fixes.length) return null;
  const names = fixes.map((f) => f.title);
  return {
    label: `Apply again (${fixes.length})`, line: "From an older oxp3-tool. Shows the plan first.", button: `Apply again (${fixes.length})`,
    title: "Apply again after the update",
    body: `${names.join(", ")}: installed by an older oxp3-tool. Applying again updates their helpers; your button choices are kept.`,
  };
};

/** "OXP3 Deck 0.6.0 available": a newer release (pre-releases too) than the running plugin. */
export const pluginNotice = (u: UpdatesAuto | null | undefined, running: string | null | undefined): Notice | null => {
  const p = u?.plugin;
  if (!p?.update || !p.latest || !running || p.current !== running) return null;
  return {
    label: `OXP3 Deck ${p.latest} available`, line: `Running ${running}. Copy the link, then install it in Decky.`, button: "Copy install URL",
    title: `OXP3 Deck ${p.latest}`,
    body: "In Decky's settings, turn on Developer mode, then open Developer → Install Plugin from URL and paste the link. Your settings are kept.",
  };
};

/** The switch's one line and Details. */
export const autoLine = (on: boolean): string => (on ? "Once a day, online and with no game running." : "Off: tap Check for an update.");

export const autoDetails = (u: UpdatesAuto | null | undefined, when: (t: number | null) => string) => ({
  title: "Check for updates automatically",
  body: "Once a day (first a few minutes after start) OXP3 Deck asks GitHub whether oxp3-tool, XeSS fast mode or OXP3 Deck has a newer version, and the closed groups say \"Update available\". Skipped while offline, while a game runs or a task is busy; a failed check is only logged. Nothing installs without a tap.",
  lines: [`last check: ${u?.checked_at ? when(u.checked_at) : "none yet"}`],
});

/** Whether the Status section has an update notice to show (then it gets a row). */
export const anyNotice = (o: { oxp3: Oxp3Install; updates?: UpdatesAuto | null; plugin_version: string } | null | undefined,
  st: Oxp3Status | null | undefined): boolean =>
  !!o && (!!bundledNotice(o.oxp3) || staleHelpers(st).length > 0 || !!pluginNotice(o.updates, o.plugin_version));
