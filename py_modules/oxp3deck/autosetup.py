"""Automatic setup (DESIGN.md "Automatic setup (0.6)"): with the user's one switch on, each game gets its best known
setup by itself while it is not running, every change is recorded with a one-line why and can be undone, and a
change after which the game closed at once is undone before its next start.

The backend decides (plan), runs the OptiScaler jobs, keeps the records and does the crash bookkeeping; the frontend
writes the launch options and the Proton through SteamClient and reports each change (record). The state is root's
DECKY_PLUGIN_SETTINGS_DIR/auto.json; that folder is the user's, so every field is checked when it is read.

Every public function answers {ok, error, ...} and never raises.
"""
from __future__ import annotations

import copy
import json
import logging
import math
import os
import re
import threading
import time

from . import context, games, optigames, optiscaler, steamlib, xess

log = logging.getLogger("oxp3deck")

VERSION = 1
PLAN_VERSION = 2          # raised whenever the tables (below, games, optigames) change: seen games are planned again
STATE_NAME = "auto.json"
READ_MAX = 1 << 20
MAX_GAMES = 400
MAX_CHANGES = 12
QUICK_EXIT_S = 60
REPEAT_EXITS = 3          # quick exits in a row that undo even a tested change
PENDING_MAX = 8
APPIDS_MAX = 2000
TOOLS_MAX = 200
HAND_MAX = 32
STEAM_MAX = 1 << 31       # non-Steam shortcuts have appids above this

# The games src/launchopts.ts DX12_ARGS names (the same appids).
DX12_APPIDS = ("292030",)
MANAGED_KEYS = games.MANAGED_KEYS
NEVER_AUTO = ("XESS_FG", "FSR_FG")      # src/launchopts.ts NEVER_AUTO: never from an automatic key change
CLASSES = ("known", "unknown", "skipped")
MODES = ("auto", "manual")
MODE_BY = ("default", "user", "detected")
KINDS = ("opti", "launch", "proton")
STATES = ("live", "undone", "rolled_back", "superseded")
NOTE_KINDS = ("restart", "unhooked", "none", "user_pick")

SAFE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
SAFE_ARG = re.compile(r"^-{0,2}[A-Za-z0-9][A-Za-z0-9._:=-]{0,31}$")
TOOL_NAME = re.compile(r"^[A-Za-z0-9._+ -]{1,64}$")
GE_NAME = re.compile(r"^GE-Proton(\d+)-(\d+)$")
CHANGE_ID = re.compile(r"^(opti|launch|proton)-[0-9]{1,12}(-[0-9]{1,3})?$")
_APPID = re.compile(r"^[0-9]{1,10}$")
_BUILD = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")

LIMITS = {"label": 40, "why": 200, "short": 40, "name": 120, "skip_why": 300, "mode_why": 200, "notice": 300,
          "last_error": 300, "display": 64}

EXPERIMENTAL = "proton_experimental"
NEEDS_XESS = "Install XeSS fast mode first (XeSS tab)."
NOTE_NONE = "Install GE-Proton or Proton Experimental, then restart Steam."
NOTE_NONE_DETAIL = ("GE-Proton: install it with ProtonUp-Qt in Desktop Mode, or with a Decky Proton manager such as "
                    "Wine Cellar. Proton Experimental: in the Steam library (Tools). Then restart Steam; OXP3 Deck "
                    "moves the game at its next pass.")
OPTI_LINE = "OptiScaler may help this game; untested here."
FSR_LINE = "FSR → XeSS: the game's FSR runs on XeSS."

_LOCK = threading.RLock()
_now = time.time          # tests replace it


def _err(why: str, **extra) -> dict:
    out = {"ok": False, "error": why}
    out.update(extra)
    return out


def _text(v, limit: int) -> str | None:
    """A string cut to `limit` characters, control characters out; None for anything else."""
    if not isinstance(v, str):
        return None
    v = _CTRL.sub(" ", v).strip()
    return v[:limit] if v else None


def _cut(v: str, limit: int) -> str:
    """At most `limit` characters, cut at a word where one is near."""
    v = _CTRL.sub(" ", v or "").strip()
    if len(v) <= limit:
        return v
    head = v[:limit - 1]
    sp = head.rfind(" ")
    return (head[:sp] if sp > limit // 2 else head).rstrip(" ,;:") + "…"


def _num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return float(v)


def _int(v, lo: int, hi: int) -> int | None:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        return None
    return v


def _appid(appid) -> str | None:
    appid = str(appid) if isinstance(appid, (str, int)) and not isinstance(appid, bool) else ""
    return appid if _APPID.match(appid) else None


def _steam_app(appid: str) -> bool:
    return 0 < int(appid) < STEAM_MAX


# ---- the state file ------------------------------------------------------------------------------------------------

def _path(ctx) -> str:
    return os.path.join(ctx.settings_dir, STATE_NAME)


def _empty() -> dict:
    return {"version": VERSION, "on": False, "confirmed_at": None, "plan_version": PLAN_VERSION, "games": {}}


def _norm_keys(v, *, values: bool) -> dict | None:
    if not isinstance(v, dict) or len(v) > 8:
        return None
    out = {}
    for k, val in v.items():
        if k not in MANAGED_KEYS or not isinstance(val, str) or not SAFE.match(val):
            return None
        out[k] = val
    return out


def _norm_applied(v) -> dict | None:
    """AutoApplied {set, dropped, args}, or None when any part is bad."""
    if not isinstance(v, dict):
        return None
    s, d = _norm_keys(v.get("set", {}), values=True), _norm_keys(v.get("dropped", {}), values=True)
    args = v.get("args", [])
    if s is None or d is None or not isinstance(args, list) or len(args) > 8:
        return None
    if not all(isinstance(a, str) and SAFE_ARG.match(a) for a in args):
        return None
    return {"set": s, "dropped": d, "args": list(dict.fromkeys(args))}


def _norm_proton(v) -> dict | None:
    if not isinstance(v, dict):
        return None
    frm, to = v.get("from"), v.get("to")
    prio = _int(v.get("from_priority"), 0, 10000)
    if not isinstance(frm, str) or (frm and not TOOL_NAME.match(frm)) or not isinstance(to, str) \
            or not TOOL_NAME.match(to) or prio is None:
        return None
    disp = _text(v.get("to_display"), LIMITS["display"]) or to
    return {"from": frm, "from_priority": prio, "to": to, "to_display": disp}


def _norm_choices(v) -> dict | None:
    if not isinstance(v, dict):
        return None
    up, fg, inp = v.get("upscaler"), v.get("fg"), v.get("fg_input")
    if up not in optiscaler.UPSCALERS or _int(fg, 0, 4) not in optiscaler.FG_MULTIPLIERS or \
            inp not in optigames.FG_INPUTS:
        return None
    return {"upscaler": up, "fg": fg, "fg_input": inp}


def _norm_opti(v) -> dict | None:
    if not isinstance(v, dict) or not isinstance(v.get("build"), str) or not _BUILD.match(v["build"]):
        return None
    ch = _norm_choices(v.get("choices"))
    return {"build": v["build"], "choices": ch} if ch else None


def _norm_change(c) -> dict | None:
    if not isinstance(c, dict):
        return None
    cid, kind = c.get("id"), c.get("kind")
    at = _num(c.get("at"))
    if not isinstance(cid, str) or not CHANGE_ID.match(cid) or kind not in KINDS or at is None \
            or not cid.startswith(kind + "-"):
        return None
    out = {"id": cid, "kind": kind, "at": at, "state": c.get("state") if c.get("state") in STATES else "live",
           "tested": c.get("tested") is True, "kept": c.get("kept") is True, "accepted": c.get("accepted") is True,
           "label": _text(c.get("label"), LIMITS["label"]) or kind,
           "why": _text(c.get("why"), LIMITS["why"]) or "",
           "short": _text(c.get("short"), LIMITS["short"]) or "",
           "ended_at": _num(c.get("ended_at"))}
    payload = {"launch": _norm_applied, "proton": _norm_proton, "opti": _norm_opti}[kind](c.get(kind))
    if payload is None:
        return None
    out[kind] = payload
    return out


def _norm_game(appid: str, g) -> dict | None:
    if not isinstance(g, dict):
        return None
    changes = []
    seen = set()
    for c in g.get("changes") if isinstance(g.get("changes"), list) else []:
        n = _norm_change(c)
        if n is not None and n["id"] not in seen:
            seen.add(n["id"])
            changes.append(n)
    s = g.get("session") if isinstance(g.get("session"), dict) else {}
    rb = g.get("rollback_due")
    return {
        "appid": appid,
        "name": _text(g.get("name"), LIMITS["name"]) or appid,
        "class": g.get("class") if g.get("class") in CLASSES else "unknown",
        "skip_why": _text(g.get("skip_why"), LIMITS["skip_why"]),
        "mode": g.get("mode") if g.get("mode") in MODES else "auto",
        "mode_why": _text(g.get("mode_why"), LIMITS["mode_why"]),
        "mode_by": g.get("mode_by") if g.get("mode_by") in MODE_BY else "default",
        "seen_at": _num(g.get("seen_at")) or 0.0,
        "plan_version": _int(g.get("plan_version"), 0, 1 << 30) or 0,
        "changes": changes[-MAX_CHANGES * 2:],
        "session": {"started_at": _num(s.get("started_at")), "quick_exits": _int(s.get("quick_exits"), 0, 1000) or 0,
                    "last_run_s": _num(s.get("last_run_s"))},
        "rollback_due": rb if isinstance(rb, str) and rb in seen else None,
        "notice": _text(g.get("notice"), LIMITS["notice"]),
        "last_error": _text(g.get("last_error"), LIMITS["last_error"]),
    }


def _load(ctx) -> dict:
    st = _empty()
    raw = context.read_small(_path(ctx), READ_MAX)
    if raw is None:
        return st
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        log.warning("autosetup: %s is not valid JSON; starting empty", _path(ctx))
        return st
    if not isinstance(data, dict):
        return st
    st["on"] = data.get("on") is True
    st["confirmed_at"] = _num(data.get("confirmed_at"))
    gs = data.get("games")
    if isinstance(gs, dict):
        for k, v in gs.items():
            a = _appid(k)
            g = _norm_game(a, v) if a else None
            if g is not None:
                st["games"][a] = g
    _trim(st)
    return st


def _live(g: dict) -> list[dict]:
    return [c for c in g["changes"] if c["state"] == "live"]


def _trim_changes(g: dict) -> None:
    while len(g["changes"]) > MAX_CHANGES:
        keep = {g["rollback_due"]}
        old = [c for c in g["changes"] if c["state"] != "live" and c["id"] not in keep] or \
            [c for c in g["changes"] if c["id"] not in keep]
        if not old:
            break
        g["changes"].remove(min(old, key=lambda c: c["at"]))


def _trim(st: dict) -> None:
    for g in st["games"].values():
        _trim_changes(g)
    while len(st["games"]) > MAX_GAMES:
        quiet = [g for g in st["games"].values() if not _live(g)] or list(st["games"].values())
        del st["games"][min(quiet, key=lambda g: g["seen_at"])["appid"]]


def _save(ctx, st: dict) -> None:
    _trim(st)
    st["plan_version"] = PLAN_VERSION
    while True:
        blob = (json.dumps(st, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        if len(blob) <= READ_MAX or not st["games"]:
            break
        quiet = [g for g in st["games"].values() if not _live(g)] or list(st["games"].values())
        del st["games"][min(quiet, key=lambda g: g["seen_at"])["appid"]]
    context.write_atomic(_path(ctx), blob, 0o644)


def _safe(name: str, fn):
    """fn() -> dict; an exception becomes {ok: false, error}."""
    try:
        return fn()
    except Exception as e:
        log.exception("autosetup: %s", name)
        return _err(f"automatic setup: {type(e).__name__}: {e}")


# ---- the switch ----------------------------------------------------------------------------------------------------

def state(ctx) -> dict:
    """AutoStateRes: {ok, error, on, confirmed_at, games}."""
    def go():
        with _LOCK:
            st = _load(ctx)
        return {"ok": True, "error": None, "on": st["on"], "confirmed_at": st["confirmed_at"], "games": st["games"]}
    return _safe("state", go)


def enable(ctx, on, confirmed=False) -> dict:
    """Turn the switch on (only with confirmed=True: the user confirmed the dialog) or off."""
    def go():
        if not isinstance(on, bool):
            return _err("automatic setup: on must be true or false")
        if on and confirmed is not True:
            return _err("automatic setup: turning it on needs the confirmation dialog")
        with _LOCK:
            st = _load(ctx)
            st["on"] = on
            if on:
                st["confirmed_at"] = round(_now(), 3)
            _save(ctx, st)
        return state(ctx)
    return _safe("enable", go)


# ---- which games ---------------------------------------------------------------------------------------------------

def _known(appid: str) -> bool:
    return appid in optiscaler.GAMES or appid in optigames.KNOWN or appid in games.KNOWN_ISSUES or \
        appid in DX12_APPIDS


def _classify(ctx, appid: str) -> tuple[str, str | None, str]:
    """(class, skip_why, name)."""
    if not _steam_app(appid):
        return "skipped", "Not a Steam game, so OXP3 Deck changes nothing by itself.", "This game"
    name = optiscaler.game_name(ctx, appid) or "This game"
    if not steamlib.app_install_dir(ctx, appid):
        return "skipped", f"{name} is not installed.", name
    ac = optiscaler.anticheat(ctx, appid)
    if ac is not None:
        if ac["which"] == "online":
            return "skipped", f"{name} is an online game, so OXP3 Deck changes nothing by itself.", name
        return "skipped", f"{name} uses anti-cheat ({ac['which']}), so OXP3 Deck changes nothing by itself.", name
    return ("known" if _known(appid) else "unknown"), None, name


def classify(ctx, appid) -> dict:
    """{ok, error, class, skip_why, name}."""
    def go():
        a = _appid(appid)
        if a is None:
            return _err("automatic setup: not a Steam game", **{"class": "skipped", "skip_why": None, "name": None})
        cls, why, name = _classify(ctx, a)
        return {"ok": True, "error": None, "class": cls, "skip_why": why, "name": name}
    return _safe("classify", go)


def _new_game(appid: str, name: str, cls: str, skip_why: str | None, now: float) -> dict:
    return {"appid": appid, "name": name, "class": cls, "skip_why": skip_why, "mode": "auto", "mode_why": None,
            "mode_by": "default", "seen_at": now, "plan_version": PLAN_VERSION, "changes": [],
            "session": {"started_at": None, "quick_exits": 0, "last_run_s": None}, "rollback_due": None,
            "notice": None, "last_error": None}


def _first_sight(g: dict, settings, opti_rec: dict | None, hand: list[str]) -> None:
    """Manual from the start when the user already set the game up (DESIGN.md "Per game: Automatic / Manual")."""
    why = None
    al = settings.get("ui_autolaunch") if settings is not None else None
    games_map = al.get("games") if isinstance(al, dict) else None
    if isinstance(games_map, dict) and games_map.get(g["appid"]) is False:
        why = "Automatic launch options were off for this game."
    elif opti_rec is not None and opti_rec.get("origin") != "auto":
        why = "You installed OptiScaler yourself."
    elif hand:
        why = "You set its launch options yourself."
    if why:
        g.update(mode="manual", mode_why=why, mode_by="detected")


# ---- Protons -------------------------------------------------------------------------------------------------------

def _hook(ctx, name: str | None) -> bool | None:
    """Whether the tool's folder has xess-xmx-linux's Proton hook; None when the folder is not found."""
    d = steamlib.find_tool_dir(ctx, name) if name else None
    return xess.has_hook(d) if d else None


def _good_target(ctx, name: str) -> bool:
    d = steamlib.find_tool_dir(ctx, name)
    return bool(d) and xess.has_hook(d) and xess.has_marker(os.path.join(d, xess.IGDEXT_REL)) is not False


def _pick(ctx, tools: list[dict]) -> dict | None:
    ge = []
    for t in tools:
        m = GE_NAME.match(t["name"])
        if m:
            ge.append(((int(m.group(1)), int(m.group(2))), t))
    for _v, t in sorted(ge, key=lambda x: x[0], reverse=True):
        if _good_target(ctx, t["name"]):
            return dict(t)
    exp = next((t for t in tools if t["name"] == EXPERIMENTAL), None)
    if exp and _good_target(ctx, exp["name"]):
        return dict(exp)
    return None


def pick_proton(ctx, tools) -> dict | None:
    """The Proton a game that uses XeSS is moved to: the newest listed GE-Proton (numeric order) whose folder has the
    hook (and a shim igdext64.dll, or none), else Proton Experimental when listed and hooked, else None. tools:
    GetAvailableCompatTools' list [{name, display}]."""
    try:
        good = _tools(tools)
        return _pick(ctx, good) if good is not None else None
    except Exception:
        log.exception("autosetup: pick_proton")
        return None


def _no_target_note(ctx, tools: list[dict]) -> dict:
    listed = {t["name"] for t in tools}
    root = steamlib.steam_root(ctx)
    if root:
        base = os.path.join(root, "compatibilitytools.d")
        try:
            names = os.listdir(base)
        except OSError:
            names = []
        ge = sorted((n for n in names if GE_NAME.match(n)), key=lambda n: tuple(map(int, GE_NAME.match(n).groups())),
                    reverse=True)
        for n in ge:
            if n not in listed and xess.has_hook(os.path.join(base, n)):
                return {"kind": "restart", "line": f"Restart Steam to use {n}.",
                        "detail": f"{n} is installed and has the XeSS add-on, but Steam lists it only after a "
                                  "restart. Restart Steam; OXP3 Deck moves the game at its next pass."}
    cand = [t for t in tools if GE_NAME.match(t["name"])]
    cand.sort(key=lambda t: tuple(map(int, GE_NAME.match(t["name"]).groups())), reverse=True)
    cand += [t for t in tools if t["name"] == EXPERIMENTAL]
    if cand:
        t = cand[0]
        return {"kind": "unhooked", "line": _cut(f"{t['display']} lacks the XeSS add-on: repair XeSS fast mode "
                                                 "(XeSS tab).", 80),
                "detail": f"{t['display']} is installed but has no XeSS add-on (its user_settings.py does not run "
                          "xess-xmx-linux's hook), so XESS=latest and the FSR routes would do nothing there. Repair "
                          "XeSS fast mode on the XeSS tab: it adds the hook to every Proton in "
                          "compatibilitytools.d and to Valve's Protons."}
    return {"kind": "none", "line": NOTE_NONE, "detail": NOTE_NONE_DETAIL}


# ---- facts ---------------------------------------------------------------------------------------------------------

def _tools(v) -> list[dict] | None:
    if not isinstance(v, list) or len(v) > TOOLS_MAX:
        return None
    out = []
    for t in v:
        if not isinstance(t, dict) or not isinstance(t.get("name"), str) or not TOOL_NAME.match(t["name"]):
            return None
        out.append({"name": t["name"], "display": _text(t.get("display"), LIMITS["display"]) or t["name"]})
    return out


def _facts(f) -> tuple[dict | None, str | None]:
    if not isinstance(f, dict):
        return None, "automatic setup: facts must be an object"
    compat = f.get("compat")
    if compat is not None:
        if not isinstance(compat, dict):
            return None, "automatic setup: facts.compat must be an object or null"
        name = compat.get("name", "")
        prio = _int(compat.get("priority", 0), 0, 10000)
        if not isinstance(name, str) or (name and not TOOL_NAME.match(name)) or prio is None:
            return None, "automatic setup: facts.compat is not a compatibility tool"
        compat = {"name": name, "display": _text(compat.get("display"), LIMITS["display"]) or name, "priority": prio}
    tools = _tools(f.get("tools", []))
    if tools is None:
        return None, "automatic setup: facts.tools must be a list of compatibility tools"
    hand = f.get("hand", [])
    if not isinstance(hand, list) or len(hand) > HAND_MAX or \
            not all(isinstance(h, str) and 0 < len(h) <= 64 for h in hand):
        return None, "automatic setup: facts.hand must be a list of short strings"
    running = f.get("running", False)
    if not isinstance(running, bool):
        return None, "automatic setup: facts.running must be true or false"
    return {"compat": compat, "tools": tools, "hand": list(hand), "running": running}, None


# ---- the plan ------------------------------------------------------------------------------------------------------

def _content(c: dict):
    """What a change did, to tell a change applied again from another one."""
    if c["kind"] == "launch":
        a = c["launch"]
        return ("launch", tuple(sorted(a["set"].items())), tuple(sorted(a["dropped"])), tuple(sorted(a["args"])))
    if c["kind"] == "proton":
        return ("proton", c["proton"]["to"])
    return ("opti", c["opti"]["build"])


def _blocked(g: dict) -> list[dict]:
    """Rolled-back changes the plan must not apply again (until Try again)."""
    return [c for c in g["changes"] if c["state"] == "rolled_back" and not c["kept"]]


def _supersede(g: dict, facts: dict, opti_rec: dict | None, now: float) -> None:
    """A change the user replaced outside OXP3 Deck: superseded, and the game Manual."""
    compat = facts["compat"]
    for c in _live(g):
        why = None
        # any other Proton than ours: picked in Steam, also Steam's default (force off, priority under 250)
        if c["kind"] == "proton" and compat is not None and compat["name"] != c["proton"]["to"]:
            why = "You picked another Proton."
        elif c["kind"] == "opti" and opti_rec is None:
            why = "OptiScaler was removed outside OXP3 Deck."
        if why:
            c.update(state="superseded", ended_at=now)
            if g["rollback_due"] == c["id"]:
                g["rollback_due"] = None
            g.update(mode="manual", mode_why=why, mode_by="detected")


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _build_plan(ctx, settings, appid: str, g: dict, facts: dict, opti_rec: dict | None, on: bool) -> dict:
    name = g["name"]
    out = {"appid": appid, "name": name, "on": on, "class": g["class"], "skip_why": g["skip_why"],
           "mode": g["mode"], "mode_why": g["mode_why"], "opti": None, "launch": None, "proton": None,
           "proton_note": None, "offers": [], "rollback": None, "needs_xess": False, "opti_why": None,
           "game": copy.deepcopy(g)}
    rb = next((c for c in g["changes"] if c["id"] == g["rollback_due"] and c["state"] == "live"), None)
    out["rollback"] = copy.deepcopy(rb) if rb else None
    if g["class"] == "skipped":
        return out
    det = xess.detect(ctx, settings)
    installed = bool(det.get("installed"))
    out["needs_xess"] = not installed
    gi = games.game_info(ctx, settings, appid)
    info = gi.get("game") if gi.get("ok") else None
    if info is None:
        out["opti_why"] = gi.get("error")
        return out
    blocked = _blocked(g)
    entry = optiscaler.entry(appid)
    build = (entry or {}).get("build") or optiscaler.DEFAULT_BUILD

    # OptiScaler: automatic only where the table says so, offered elsewhere
    auto = (entry or {}).get("auto")
    chk = None
    if opti_rec is None:
        # while the game runs: the other refusals (a file in the way); the job asks again before it starts
        chk = optiscaler.check(ctx, appid, installing=True, auto=True, ignore_running=True)
    opti_blocked = any(c["kind"] == "opti" and c["opti"]["build"] == build for c in blocked)
    if g["class"] == "known" and auto and opti_rec is None:
        if not installed:
            out["opti_why"] = NEEDS_XESS
        elif opti_blocked:
            out["opti_why"] = "OptiScaler was undone after a quick exit; tap Try again to use it again."
        elif chk and chk["ok"]:
            out["opti"] = {"choices": dict(auto["choices"]), "why": auto["why"], "short": auto["short"]}
        else:
            out["opti_why"] = chk["why"] if chk else None
    opti_in = opti_rec is not None or out["opti"] is not None
    if not opti_in and chk and chk["ok"] and not opti_blocked:
        out["offers"].append({"id": "opti", "label": "OptiScaler", "line": OPTI_LINE,
                              "why": ("OptiScaler's wiki documents this game; " if entry else "") +
                                     "OXP3 Deck has not tested it here, so it installs it only when you ask. "
                                     "Remove puts everything back."})

    # The Proton move
    compat = facts["compat"]
    uses_xess = any(d.get("kind") == "xess" for d in info.get("dlls") or []) or opti_in
    post_hook = info.get("compat_tool_hook")
    if compat is not None:
        eff = compat["name"] if compat["priority"] > 0 and compat["name"] else steamlib.default_compat_tool(ctx)
        ours = any(c["kind"] == "proton" and c["proton"]["to"] == compat["name"] for c in _live(g))
        user_pick = compat["priority"] >= 250 and not ours
        cur_hook = _hook(ctx, eff)
        post_hook = cur_hook
        if installed and uses_xess and cur_hook is not True:
            target = _pick(ctx, facts["tools"])
            disp = compat["display"] if eff == compat["name"] else (eff or "Steam's default Proton")
            if user_pick:
                out["proton_note"] = {"kind": "user_pick",
                                      "line": _cut(f"Your Proton for {name} lacks the XeSS add-on.", 80),
                                      "detail": f"You picked {disp} for {name}; OXP3 Deck never changes a Proton you "
                                                "picked. XeSS's fast mode and XESS=latest need a Proton with the "
                                                "XeSS add-on" + (f", such as {target['display']}." if target else
                                                                 ".")}
                if target and target["name"] != compat["name"]:
                    out["offers"].append({"id": "proton", "label": _cut(target["display"], 40),
                                          "line": _cut(f"Use {target['display']} for XeSS.", 80),
                                          "why": f"{target['display']} has the XeSS add-on; {disp} does not."})
            elif target is None:
                out["proton_note"] = _no_target_note(ctx, facts["tools"])
            elif target["name"] != eff and not any(c["kind"] == "proton" and c["proton"]["to"] == target["name"]
                                                   for c in blocked):
                out["proton"] = {"to": target["name"], "to_display": target["display"],
                                 "why": _cut(f"{name} uses XeSS and {disp} lacks the XeSS add-on; "
                                             f"{target['display']} has it.", LIMITS["why"])}
                post_hook = True

    # Launch options
    issues = games.known_issues(appid)
    drop = list(dict.fromkeys(k for i in issues for k in i.get("auto_drop", ())))
    never = set(k for i in issues for k in i.get("auto_never", ())) | set(NEVER_AUTO)
    blocked_set = {(k, v) for c in blocked if c["kind"] == "launch" for k, v in c["launch"]["set"].items()}
    blocked_drop = {k for c in blocked if c["kind"] == "launch" for k in c["launch"]["dropped"]}
    sugg = games.suggest(det, dict(info, compat_tool_hook=post_hook)) if installed else []
    sets, whys = {}, []
    for s in sugg:
        k, v = s["key"], s["value"]
        if k == "FSR":
            if not opti_in and k not in never:
                out["offers"].append({"id": "fsr", "label": "FSR=xess", "line": FSR_LINE,
                                      "why": _cut(s["why"] + " It replaces the game's signed FidelityFX files while "
                                                  "it runs, so OXP3 Deck does not do it by itself.", LIMITS["why"])})
            continue
        if opti_in or k in never or (k, v) in blocked_set:
            continue
        if k not in MANAGED_KEYS or not SAFE.match(v):
            continue
        sets[k] = v
        whys.append(s["why"])
    remove = [k for k in drop if k not in blocked_drop and not (opti_in and k in optiscaler.LAUNCH_REMOVE)]
    if remove:
        whys.append(f"{_and(remove)} {'is' if len(remove) == 1 else 'are'} known to break {name}, so "
                    f"{'it is' if len(remove) == 1 else 'they are'} taken out.")
    if sets or remove:
        out["launch"] = {"plan": {"set": sets, "remove": remove, "dll_override": None, "dxvk_config": None,
                                  "args": []},
                         "why": _cut(" ".join(whys), LIMITS["why"]),
                         "short": "for XeSS" if sets else "keys that break it out"}
    return out


def _hand(g: dict, hand: list[str]) -> list[str]:
    """facts.hand less what a live automatic launch change set (the frontend subtracts them too, from its copy of
    the state, which can be missing)."""
    ours = set()
    for c in _live(g):
        if c["kind"] == "launch":
            ours |= {f"{k}={v}" for k, v in c["launch"]["set"].items()} | set(c["launch"]["args"])
    return [h for h in hand if h not in ours]


def plan(ctx, settings, appid, facts) -> dict:
    """AutoPlanRes {ok, error, plan}: what the automatic setup would do for the game now. With the switch on the game
    is recorded (first sight decides Automatic or Manual) and changes the user replaced become superseded."""
    def go():
        a = _appid(appid)
        if a is None:
            return _err("automatic setup: not a Steam game", plan=None)
        f, why = _facts(facts)
        if f is None:
            return _err(why, plan=None)
        cls, skip_why, name = _classify(ctx, a)
        opti_rec = optiscaler.game_record(ctx, a)
        now = round(_now(), 3)
        with _LOCK:
            st = _load(ctx)
            g = st["games"].get(a)
            if g is None:
                g = _new_game(a, name, cls, skip_why, now)
                if cls != "skipped":
                    _first_sight(g, settings, opti_rec, f["hand"])
            g.update(name=name, skip_why=skip_why, seen_at=now, plan_version=PLAN_VERSION)
            g["class"] = cls
            _supersede(g, f, opti_rec, now)
            hand = _hand(g, f["hand"])
            if cls != "skipped" and g["mode"] == "auto" and g["mode_by"] == "default" and hand:
                g.update(mode="manual", mode_why="You set its launch options yourself.", mode_by="detected")
            if st["on"]:
                st["games"][a] = g
                _save(ctx, st)
            g = copy.deepcopy(g)
            on = st["on"]
        # an automatic OptiScaler install on choices the table has since replaced gets the new ones (not by hand)
        if on and g["mode"] == "auto" and opti_rec is not None and opti_rec.get("origin") == "auto" and \
                optiscaler.migrate_auto(ctx, a):
            opti_rec = optiscaler.game_record(ctx, a)
        return {"ok": True, "error": None, "plan": _build_plan(ctx, settings, a, g, f, opti_rec, on)}
    return _safe("plan", go)


def pending(ctx, appids) -> dict:
    """AutoPendingRes {ok, error, appids}: at most PENDING_MAX games the library scan should plan now: unseen, seen
    under an older PLAN_VERSION, or with a rollback due; a rollback due first, then known games. appids None: the
    installed apps from the libraries' manifests."""
    def go():
        ids = appids
        if ids is None:
            ids = [x["appid"] for x in steamlib.installed_apps(ctx)]
        if not isinstance(ids, list) or len(ids) > APPIDS_MAX or \
                not all(isinstance(x, str) and _APPID.match(x) for x in ids):
            return _err(f"automatic setup: appids must be a list of at most {APPIDS_MAX} Steam app ids", appids=[])
        with _LOCK:
            st = _load(ctx)
        if not st["on"]:
            return {"ok": True, "error": None, "appids": []}
        want = []
        for x in dict.fromkeys(ids):
            if not _steam_app(x):
                continue
            g = st["games"].get(x)
            if g is None or g["plan_version"] < PLAN_VERSION or g["rollback_due"]:
                want.append(x)
        want.sort(key=lambda x: (not (st["games"].get(x) or {}).get("rollback_due"), not _known(x)))
        return {"ok": True, "error": None, "appids": want[:PENDING_MAX]}
    return _safe("pending", go)


# ---- records -------------------------------------------------------------------------------------------------------

def _new_id(g: dict, kind: str, now: float) -> str:
    base = f"{kind}-{int(now)}"
    ids = {c["id"] for c in g["changes"]}
    if base not in ids:
        return base
    for i in range(2, 1000):
        if f"{base}-{i}" not in ids:
            return f"{base}-{i}"
    raise ValueError("too many changes in one second")


def _add_change(g: dict, kind: str, payload: dict, *, label: str, why: str, short: str, accepted: bool,
                now: float) -> dict:
    c = {"id": _new_id(g, kind, now), "kind": kind, "at": now, "state": "live", "tested": accepted, "kept": False,
         "accepted": accepted, "label": _cut(label, LIMITS["label"]) or kind, "why": _cut(why, LIMITS["why"]),
         "short": _cut(short, LIMITS["short"]), "ended_at": None, kind: payload}
    again = [o for o in g["changes"] if o["state"] == "rolled_back" and o["kept"] and _content(o) == _content(c)]
    if again:                      # Try again: only the repeated-crash rule can undo it now
        c["kept"] = c["tested"] = True
    if kind in ("proton", "opti"):  # one live change of these kinds at a time
        for o in _live(g):
            if o["kind"] == kind:
                o.update(state="superseded", ended_at=now)
    g["changes"].append(c)
    _trim_changes(g)
    return c


def _game_or_err(st: dict, appid) -> tuple[str | None, dict | None, dict | None]:
    a = _appid(appid)
    if a is None:
        return None, None, _err("automatic setup: not a Steam game", game=None)
    g = st["games"].get(a)
    if g is None:
        return a, None, _err("automatic setup: OXP3 Deck has not planned this game yet", game=None)
    return a, g, None


def record(ctx, appid, change) -> dict:
    """AutoGameRes: a launch-option or Proton change the frontend made, recorded with the backend's clock."""
    def go():
        if not isinstance(change, dict):
            return _err("automatic setup: the change must be an object", game=None)
        kind = change.get("kind")
        if kind == "opti":
            return _err("automatic setup: an OptiScaler change is recorded by its install job", game=None)
        if kind not in ("launch", "proton"):
            return _err(f"automatic setup: unknown change kind {str(kind)[:20]!r}", game=None)
        payload = _norm_applied(change.get("launch")) if kind == "launch" else _norm_proton(change.get("proton"))
        if payload is None:
            return _err(f"automatic setup: the {kind} change is not valid", game=None)
        if kind == "launch" and not (payload["set"] or payload["dropped"] or payload["args"]):
            return _err("automatic setup: the launch change changes nothing", game=None)
        accepted = change.get("accepted") is True
        label = _text(change.get("label"), 200) or (payload["to_display"] if kind == "proton" else "launch options")
        with _LOCK:
            st = _load(ctx)
            _a, g, bad = _game_or_err(st, appid)
            if bad:
                return bad
            _add_change(g, kind, payload, label=label, why=_text(change.get("why"), 1000) or "",
                        short=_text(change.get("short"), 200) or "", accepted=accepted, now=round(_now(), 3))
            _save(ctx, st)
            return {"ok": True, "error": None, "game": copy.deepcopy(g)}
    return _safe("record", go)


def set_mode(ctx, appid, mode, why=None) -> dict:
    """AutoGameRes: Automatic or Manual. Manual with a why: a manual change the frontend saw (mode_by "detected");
    without: the user's pick."""
    def go():
        if mode not in MODES:
            return _err("automatic setup: mode must be 'auto' or 'manual'", game=None)
        if why is not None and not isinstance(why, str):
            return _err("automatic setup: why must be text", game=None)
        a = _appid(appid)
        if a is None:
            return _err("automatic setup: not a Steam game", game=None)
        cls = name = skip = None
        with _LOCK:
            known = a in _load(ctx)["games"]
        if not known:
            cls, skip, name = _classify(ctx, a)
        now = round(_now(), 3)
        with _LOCK:
            st = _load(ctx)
            g = st["games"].get(a)
            if g is None:
                g = _new_game(a, name or a, cls or "unknown", skip, now)
                g["plan_version"] = 0               # not planned yet: the scan still looks at it
                st["games"][a] = g
            if mode == "auto":
                g.update(mode="auto", mode_why=None, mode_by="user")
            elif why:
                if g["mode"] != "manual":
                    g.update(mode="manual", mode_why=_cut(why, LIMITS["mode_why"]), mode_by="detected")
            else:
                g.update(mode="manual", mode_why="You picked Manual.", mode_by="user")
            _save(ctx, st)
            return {"ok": True, "error": None, "game": copy.deepcopy(g)}
    return _safe("set_mode", go)


def _what(c: dict) -> str:
    if c["kind"] == "proton":
        return f"moved it to {c['proton']['to_display']}"
    if c["kind"] == "opti":
        return "installed OptiScaler"
    return f"changed its launch options ({c['label']})"


def _mark(g: dict, c: dict, reason: str, now: float) -> None:
    c["ended_at"] = now
    if g["rollback_due"] == c["id"]:
        g["rollback_due"] = None
    if reason == "rollback":
        c["state"] = "rolled_back"
        for o in g["changes"]:                 # a Try again is used up
            if o["state"] == "rolled_back" and _content(o) == _content(c):
                o["kept"] = False
        g["notice"] = _cut(f"{g['name']} closed within a minute after OXP3 Deck {_what(c)}, so that change is undone.",
                           LIMITS["notice"])
        g["session"]["quick_exits"] = 0
    else:
        c["state"] = "undone"
        g.update(mode="manual", mode_why="You tapped Undo.", mode_by="detected")


def undone(ctx, appid, change_id, reason="user") -> dict:
    """The frontend undid a launch or Proton change (reason "user" | "rollback"): marked undone / rolled back.
    An OptiScaler change still in the game answers kind "opti" and is marked by its remove job (opti_undo)."""
    def go():
        if reason not in ("user", "rollback"):
            return _err("automatic setup: reason must be 'user' or 'rollback'", game=None, kind=None)
        if not isinstance(change_id, str):
            return _err("automatic setup: bad change id", game=None, kind=None)
        with _LOCK:
            st = _load(ctx)
            a, g, bad = _game_or_err(st, appid)
            if bad:
                return dict(bad, kind=None)
            c = next((x for x in g["changes"] if x["id"] == change_id), None)
            if c is None or c["state"] != "live":
                return _err(f"automatic setup: no live change {change_id[:40]}", game=copy.deepcopy(g), kind=None)
            if c["kind"] == "opti" and optiscaler.game_record(ctx, a) is not None:
                return {"ok": True, "error": None, "game": copy.deepcopy(g), "kind": "opti"}
            _mark(g, c, reason, round(_now(), 3))
            _save(ctx, st)
            return {"ok": True, "error": None, "game": copy.deepcopy(g), "kind": c["kind"]}
    return _safe("undone", go)


def opti_undo_precheck(ctx, appid, change_id) -> str | None:
    """Why the OptiScaler remove for an Undo cannot start, or None."""
    try:
        a = _appid(appid)
        if a is None:
            return "automatic setup: not a Steam game"
        with _LOCK:
            g = _load(ctx)["games"].get(a)
        c = next((x for x in (g or {}).get("changes", []) if x["id"] == change_id), None)
        if c is None or c["state"] != "live" or c["kind"] != "opti":
            return f"automatic setup: no live OptiScaler change {str(change_id)[:40]}"
        return optiscaler.check(ctx, a, installing=False)["why"]
    except Exception as e:
        log.exception("autosetup: opti_undo_precheck")
        return f"automatic setup: {type(e).__name__}: {e}"


def opti_undo(ctx, settings, job, appid, change_id, reason="user") -> dict:
    """The job of an OptiScaler Undo (or rollback): optiscaler.remove, then the change is marked when it worked.
    OptiJobResult plus game."""
    a = _appid(appid) or ""
    res = optiscaler.remove(ctx, settings, job, a)
    if res.get("ok") and not res.get("kept"):
        with _LOCK:
            st = _load(ctx)
            g = st["games"].get(a)
            c = next((x for x in (g or {}).get("changes", []) if x["id"] == change_id), None)
            if c is not None and c["state"] in ("live", "superseded"):
                _mark(g, c, reason if reason in ("user", "rollback") else "user", round(_now(), 3))
                _save(ctx, st)
            res = dict(res, game=copy.deepcopy(g))
    elif not res.get("ok"):
        _set_error(ctx, a, f"Undo of OptiScaler failed: {res.get('error')}")
    return res


def retry(ctx, appid, change_id) -> dict:
    """AutoGameRes: a rolled-back change may be applied once more ("Try again"); it is then kept (tested)."""
    def go():
        if not isinstance(change_id, str):
            return _err("automatic setup: bad change id", game=None)
        with _LOCK:
            st = _load(ctx)
            _a, g, bad = _game_or_err(st, appid)
            if bad:
                return bad
            c = next((x for x in g["changes"] if x["id"] == change_id), None)
            if c is None or c["state"] != "rolled_back":
                return _err(f"automatic setup: no rolled-back change {change_id[:40]}", game=copy.deepcopy(g))
            c["kept"] = True
            g["notice"] = None
            g["session"]["quick_exits"] = 0
            _save(ctx, st)
            return {"ok": True, "error": None, "game": copy.deepcopy(g)}
    return _safe("retry", go)


def _set_error(ctx, appid: str, why: str | None) -> None:
    try:
        with _LOCK:
            st = _load(ctx)
            g = st["games"].get(appid)
            if g is not None:
                g["last_error"] = _cut(why, LIMITS["last_error"]) if why else None
                _save(ctx, st)
    except Exception:
        log.exception("autosetup: last_error")


# ---- sessions and the crash rollback -------------------------------------------------------------------------------

def session(ctx, appid, event) -> dict:
    """AutoSessionRes {ok, error, rollback, game}: "start" when the game starts, "exit" when it ends. A run shorter
    than QUICK_EXIT_S undoes the newest untested change made before its start (or, after REPEAT_EXITS quick exits
    in a row, the newest one); a longer run marks the earlier changes tested."""
    def go():
        if event not in ("start", "exit"):
            return _err("automatic setup: event must be 'start' or 'exit'", rollback=None, game=None)
        a = _appid(appid)
        if a is None:
            return _err("automatic setup: not a Steam game", rollback=None, game=None)
        started = steamlib.game_started_at(ctx, a) if event == "start" else None
        now = round(_now(), 3)
        with _LOCK:
            st = _load(ctx)
            g = st["games"].get(a)
            if g is None:
                return {"ok": True, "error": None, "rollback": None, "game": None}
            s = g["session"]
            if event == "start":
                t = round(started, 3) if started is not None and started <= now + 5 else now
                if s["started_at"] == t:
                    return {"ok": True, "error": None, "rollback": None, "game": copy.deepcopy(g)}
                s["started_at"] = t
                _save(ctx, st)
                return {"ok": True, "error": None, "rollback": None, "game": copy.deepcopy(g)}
            t0 = s["started_at"]
            if t0 is None:
                return {"ok": True, "error": None, "rollback": None, "game": copy.deepcopy(g)}
            s["started_at"] = None
            run = max(0.0, now - t0)
            s["last_run_s"] = round(run, 1)
            before = [c for c in _live(g) if c["at"] < t0]
            rollback = None
            if run >= QUICK_EXIT_S:
                for c in before:
                    c["tested"] = True
                s["quick_exits"] = 0
            else:
                s["quick_exits"] += 1
                untested = [c for c in before if not c["tested"]]
                if untested:
                    rollback = max(untested, key=lambda c: c["at"])
                elif s["quick_exits"] >= REPEAT_EXITS and before:
                    rollback = max(before, key=lambda c: c["at"])
                if rollback is not None and not st["on"]:
                    rollback = None                        # no passes while the switch is off
                if rollback is not None:
                    g["rollback_due"] = rollback["id"]
                    s["quick_exits"] = 0
            _save(ctx, st)
            return {"ok": True, "error": None, "rollback": copy.deepcopy(rollback), "game": copy.deepcopy(g)}
    return _safe("session", go)


# ---- the automatic OptiScaler install ------------------------------------------------------------------------------

def _opti_choices(ctx, appid: str) -> dict | None:
    base = optiscaler.entry(appid)
    auto = (base or {}).get("auto")
    if auto:
        return dict(auto["choices"])
    e, _why = optiscaler.resolve(ctx, appid, fresh=True)
    e = e or base
    return optiscaler.defaults(e) if e else None


def opti_precheck(ctx, settings, appid, accepted=False) -> str | None:
    """Why auto_opti_install cannot start, or None: the switch on (or an offer the user accepted), the game
    Automatic and not skipped, and optiscaler.check(..., auto=True)."""
    try:
        a = _appid(appid)
        if a is None:
            return "automatic setup: not a Steam game"
        with _LOCK:
            st = _load(ctx)
        if not st["on"] and accepted is not True:
            return "Automatic setup is off."
        g = st["games"].get(a)
        if g is None:
            return "automatic setup: OXP3 Deck has not planned this game yet"
        if g["mode"] != "auto":
            return f"{g['name']} is set to Manual."
        cls, skip, _name = _classify(ctx, a)
        if cls == "skipped":
            return skip
        if _opti_choices(ctx, a) is None:
            return optiscaler.check(ctx, a, installing=True, auto=True)["why"] or optiscaler.NO_SETUP
        return optiscaler.check(ctx, a, installing=True, auto=True)["why"]
    except Exception as e:
        log.exception("autosetup: opti_precheck")
        return f"automatic setup: {type(e).__name__}: {e}"


def opti_done(ctx, appid, result, accepted=False) -> dict:
    """At the end of the automatic install job: an `opti` change on success, last_error otherwise. AutoGameRes."""
    def go():
        a = _appid(appid)
        if a is None:
            return _err("automatic setup: not a Steam game", game=None)
        if not isinstance(result, dict) or not result.get("ok"):
            why = result.get("error") if isinstance(result, dict) else None
            _set_error(ctx, a, f"OptiScaler was not installed: {why or 'the install failed'}")
            return {"ok": True, "error": None, "game": None}
        rec = optiscaler.game_record(ctx, a) or {}
        choices = _norm_choices(rec.get("choices"))
        build = rec.get("build") if isinstance(rec.get("build"), str) and _BUILD.match(rec.get("build")) else None
        if choices is None or build is None:
            return _err("automatic setup: the OptiScaler record is not readable", game=None)
        auto = (optiscaler.entry(a) or {}).get("auto")
        why = auto["why"] if auto and not accepted else "You chose OptiScaler for this game."
        short = auto["short"] if auto and not accepted else ""
        with _LOCK:
            st = _load(ctx)
            g = st["games"].get(a)
            if g is None:
                return _err("automatic setup: OXP3 Deck has not planned this game yet", game=None)
            now = round(_now(), 3)
            # OptiScaler's launch options take these keys out: a live change that only set them is replaced by it
            # (superseded, the game stays Automatic)
            for c in _live(g):
                a = c.get("launch") if c["kind"] == "launch" else None
                if a and a["set"] and not a["dropped"] and not a["args"] and \
                        all(k in optiscaler.LAUNCH_REMOVE for k in a["set"]):
                    c.update(state="superseded", ended_at=now)
                    if g["rollback_due"] == c["id"]:
                        g["rollback_due"] = None
            _add_change(g, "opti", {"build": build, "choices": choices}, label="OptiScaler", why=why, short=short,
                        accepted=accepted is True, now=now)
            g["last_error"] = None
            _save(ctx, st)
            return {"ok": True, "error": None, "game": copy.deepcopy(g)}
    return _safe("opti_done", go)


def opti_install(ctx, settings, job, appid, accepted=False) -> dict:
    """The job of auto_opti_install: the table's automatic choices (else the setup's defaults), installed with
    auto=True (no file is replaced) and origin "auto", then opti_done. OptiJobResult plus game."""
    a = _appid(appid) or ""
    choices = _opti_choices(ctx, a)
    if choices is None:
        res = {"ok": False, "error": optiscaler.NO_SETUP}
    else:
        res = optiscaler.install(ctx, settings, job, a, choices, auto=True, origin="auto")
    done = opti_done(ctx, a, res, accepted)
    return dict(res, game=done.get("game"))
