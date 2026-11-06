// "When it takes effect" (DESIGN.md "When it takes effect (effect tags)"): the five tags, the tag of every setting,
// and the texts of the pending rows. Framework-free so node can test it (tests/js/effects.test.mjs).

export type Effect = "now" | "game" | "session" | "reboot" | "idle";
/** One tag, or several shown together (["idle", "session"]: "Only while no game runs · Log out of Game Mode or reboot"). */
export type EffectSpec = Effect | Effect[];

export const EFFECT_TEXT: Record<Effect, string> = {
  now: "Now", game: "Restart the game", session: "Log out of Game Mode or reboot", reboot: "Reboot",
  idle: "Only while no game runs",
};

export const PENDING_TEXT: Record<Exclude<Effect, "now" | "idle">, string> = {
  game: "Restart the game to apply", session: "Log out of Game Mode or reboot to apply", reboot: "Reboot to apply",
};

const NOW: Effect = "now";
const XESS_PKG: Effect[] = ["idle", "session"];

/** The tag of every setting, by setting id (the table in DESIGN.md). */
export const EFFECTS: Record<string, EffectSpec> = {
  "power.enable": NOW, "power.game_profile": NOW,
  "power.pl1": NOW, "power.pl2": NOW, "power.gpu_min": NOW, "power.gpu_max": NOW, "power.epp": NOW, "power.turbo": NOW,
  "power.reset": NOW, "power.new_profile": NOW, "power.delete_profile": NOW,
  "power.per_game": NOW, "power.split_ac": NOW, "power.extended": NOW, "power.poll_s": NOW,
  "power.cpu_max_pct": NOW, "power.soc": NOW, "power.soc_offset": NOW, "power.gpu_profile": NOW, "power.cpu_min_pct": NOW,
  "power.cpu_caps": NOW, "power.epp_split": NOW,
  "power.take_control": NOW, "power.fix": NOW, "power.unfix": NOW, "power.ignore": NOW, "power.import": NOW,
  "extras.fan": NOW, "extras.scx": NOW, "extras.lpmd": NOW, "extras.charge_limit": NOW, "extras.charge_behaviour": NOW,
  "extras.take_control": NOW,
  "fix.buttons": NOW, "fix.xbox-key": NOW, "fix.volume-keys": NOW, "fix.inputplumber-suspend": NOW,
  "fix.gyro": "reboot", "fix.nvme-resume": "reboot", "fix.xe-panel-replay-off": "reboot", "fix.xe-hdr-backlight": "reboot",
  "fix.xe-dsb-off": "reboot",
  "fix.oled-profile": "session", "fix.oled-profile.min_refresh": "session",
  "fix.nvme-resume.any_ssd": "reboot",
  "buttons.layout": NOW, "buttons.layout_reboot": "reboot", "buttons.restart": NOW,
  "xess.install": XESS_PKG, "xess.update": XESS_PKG, "xess.repair": XESS_PKG, "xess.uninstall": XESS_PKG,
  "xess.driver": "game", "xess.shim": "game", "xess.remove_folder": NOW,
  "game.xess": "game", "game.fg": "game", "game.mesa": "game", "game.vendor": "game", "game.log": "game", "game.fsr": "game",
  "game.typo": "game", "game.copy": "game", "game.dx12": "game",
  "game.auto_undo": "game", "auto.global": "game", "game.auto_mode": "game", "game.auto_retry": "game", "game.auto_offer": "game",
  "game.opti": "game", "game.opti_upscaler": "game", "game.opti_fg": "game", "game.opti_input": "game",
  "game.opti_remove": "game", "game.opti_update": "game", "game.opti_overlay": "game",
  "kernel.try": "reboot", "kernel.keep": "reboot",
  "oxp3.install": NOW,
  reboot: NOW,
};

const list = (e: EffectSpec): Effect[] => (Array.isArray(e) ? e : [e]);

/** The tag's text: "Restart the game", "Only while no game runs · Log out of Game Mode or reboot". */
export const effectText = (e: EffectSpec): string => list(e).map((x) => EFFECT_TEXT[x]).join(" · ");

/** The confirm dialogs' last paragraph: "Takes effect: Restart the game." */
export const confirmLine = (e: EffectSpec): string => `Takes effect: ${effectText(e)}.`;

/** The tag of a setting id; "now" for an id the table does not know (a test checks that every used id is there). */
export const effectOf = (id: string): EffectSpec => (Object.prototype.hasOwnProperty.call(EFFECTS, id) ? EFFECTS[id] : NOW);

/**
 * The tag of an oxp3-tool fix: its row in EFFECTS, else from oxp3-tool's own takes_effect text (a fix added in a newer
 * oxp3-tool): "reboot" → Reboot, "Game Mode starts" → log out, else Now.
 */
export const fixEffect = (fix: { id: string; takes_effect?: string | null }): Effect => {
  const known = EFFECTS[`fix.${fix.id}`];
  if (known && Object.prototype.hasOwnProperty.call(EFFECTS, `fix.${fix.id}`)) {
    const l = list(known);
    return l.includes("reboot") ? "reboot" : l.includes("session") ? "session" : l.includes("game") ? "game" : "now";
  }
  const t = fix.takes_effect ?? "";
  if (/reboot/i.test(t)) return "reboot";
  if (/Game Mode starts/i.test(t)) return "session";
  return "now";
};

const RANK: Record<Effect, number> = { now: 0, game: 1, session: 2, reboot: 3, idle: -1 };

/** The tag of several changes made at once: the strongest of reboot > session > game > now; "idle" is kept alongside. */
export const strongest = (es: EffectSpec[]): EffectSpec => {
  let top: Effect = "now";
  let idle = false;
  for (const e of es) {
    for (const x of list(e)) {
      if (x === "idle") idle = true;
      else if (RANK[x] > RANK[top]) top = x;
    }
  }
  return idle ? ["idle", top] : top;
};

/** The pending row's text after a change with this tag, or null when nothing waits (now, or only "idle"). */
export const pendingText = (e: EffectSpec, game?: string | null): string | null => {
  const l = list(e);
  const k: Exclude<Effect, "now" | "idle"> | null = l.includes("reboot") ? "reboot" : l.includes("session") ? "session"
    : l.includes("game") ? "game" : null;
  if (!k) return null;
  if (k === "game" && game) return `Restart ${game} to apply`;
  return PENDING_TEXT[k];
};
