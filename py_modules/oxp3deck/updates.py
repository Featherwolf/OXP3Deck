"""Daily update checks (ROADMAP T1-9 + C-5): once a day, oxp3-tool's and xess-xmx-linux's update checks and this
plugin's newest release, so the closed Quick Access groups can say "Update available" without a tap.

Only checks: nothing is installed here. The bundled oxp3-tool and a new OXP3 Deck are one-tap offers in the frontend
(a job, and a copied install URL). A check is skipped while offline, while a game runs or a job is active, and when
the user turned "Check for updates automatically" off; a failure is only logged and tried again an hour later.

State in settings.json: `update_auto` (bool, the switch; missing = on) and AUTO_KEY {checked_at, tried_at, oxp3,
xess, plugin} (the last answers that worked, each step's own).
"""
from __future__ import annotations

import logging
import time

from . import downloads

log = logging.getLogger("oxp3deck")

SWITCH_KEY = "update_auto"         # settings.json: bool, the frontend's switch (main.SETTING_KEYS)
AUTO_KEY = "updates_auto"          # settings.json: what the last checks found
DAY_S = 24 * 3600.0                # a full check at most once per day
RETRY_S = 3600.0                   # after a failed or skipped-midway check
FIRST_S = 180.0                    # the first check, a few minutes after the plugin starts
WAKE_S = 600.0                     # how often main.py asks whether a check is due
PLUGIN_REPO = "Featherwolf/OXP3Deck"
INSTALL_URL = "https://raw.githubusercontent.com/Featherwolf/OXP3Deck/HEAD/release/OXP3Deck.zip"


def enabled(settings) -> bool:
    return settings.get(SWITCH_KEY) is not False


def _record(settings) -> dict:
    rec = settings.get(AUTO_KEY)
    return rec if isinstance(rec, dict) else {}


def _time(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def due(settings, now: float) -> bool:
    """A day since the last check that worked (or none yet), and an hour since the last try. A time in the future
    (the clock went back) counts as due."""
    rec = _record(settings)
    checked, tried = _time(rec.get("checked_at")), _time(rec.get("tried_at"))
    if tried is not None and 0 <= now - tried < RETRY_S:
        return False
    return checked is None or not 0 <= now - checked < DAY_S


def online(ctx) -> bool:
    """A default route (IPv4 or IPv6) exists: no network call. /proc/net/route's destination 00000000, or
    /proc/net/ipv6_route's ::/0 on another device than lo."""
    try:
        with open(ctx.sys_path("/proc/net/route")) as f:
            for line in f.read(65536).splitlines()[1:]:
                parts = line.split()
                if len(parts) > 3 and parts[1] == "00000000" and int(parts[3], 16) & 0x1:   # RTF_UP
                    return True
    except (OSError, ValueError):
        pass
    try:
        with open(ctx.sys_path("/proc/net/ipv6_route")) as f:
            for line in f.read(262144).splitlines():
                parts = line.split()
                if len(parts) >= 10 and parts[0] == "0" * 32 and parts[1] == "00" and parts[9] != "lo":
                    return True
    except OSError:
        pass
    return False


def plugin_check(current: str) -> dict:
    """{ok, error, current, latest, update}: OXP3 Deck's newest release (pre-releases too) against `current`."""
    try:
        latest = downloads.newest_release_tag(PLUGIN_REPO)
    except downloads.DownloadError as e:
        return {"ok": False, "error": f"OXP3 Deck update check: {e}", "current": current, "latest": None,
                "update": False}
    new, cur = downloads.semver_key(latest), downloads.semver_key(current)
    return {"ok": True, "error": None, "current": current, "latest": latest.lstrip("v"),
            "update": new is not None and cur is not None and new > cur}


def tick(ctx, settings, *, busy: str | None, game, steps: dict, now: float | None = None) -> str:
    """One look from main.py's timer: what it did ("off", "not due", "offline", "game", "busy", "checked",
    "failed"). steps: name -> fn() -> {ok, error, ...} (oxp3, xess, plugin), run in that order; an answer that
    worked replaces that step's stored one. busy: the running job's title; game: the running game's app id."""
    now = time.time() if now is None else now
    if not enabled(settings):
        return "off"
    if not due(settings, now):
        return "not due"
    if game:
        return "game"
    if busy:
        return "busy"
    if not online(ctx):
        return "offline"
    rec = dict(_record(settings))
    failed = []
    for name, fn in steps.items():
        try:
            res = fn()
        except Exception as e:      # a module that did not load, a bug: logged, never shown
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        if isinstance(res, dict) and res.get("ok"):
            rec[name] = {**res, "checked_at": now}
        else:
            failed.append(name)
            log.info("automatic update check: %s: %s", name,
                     res.get("error") if isinstance(res, dict) else f"bad answer {res!r}"[:200])
    rec["tried_at"] = now
    if not failed:
        rec["checked_at"] = now
    err = settings.set(AUTO_KEY, rec)
    if err:
        log.info("automatic update check: not saved: %s", err)
    return "failed" if failed else "checked"


def state(settings, current: str) -> dict:
    """UpdatesAuto for get_overview: the switch, when it last worked, each step's last answer, the install URL. The
    plugin answer is redone against the running version, so an update installed since is no longer offered."""
    rec = _record(settings)
    out = {"on": enabled(settings), "checked_at": _time(rec.get("checked_at")), "install_url": INSTALL_URL}
    for name in ("oxp3", "xess", "plugin"):
        v = rec.get(name)
        out[name] = v if isinstance(v, dict) else None
    p = out["plugin"]
    if p is not None:
        latest = p.get("latest") if isinstance(p.get("latest"), str) else None
        new, cur = downloads.semver_key(latest), downloads.semver_key(current)
        out["plugin"] = {"current": current, "latest": latest, "checked_at": _time(p.get("checked_at")),
                         "update": new is not None and cur is not None and new > cur}
    return out
