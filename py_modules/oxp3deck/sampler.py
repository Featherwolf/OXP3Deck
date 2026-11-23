"""The background power sampler and the per-game TDP advisor (DESIGN.md "Performance batch" E, ROADMAP T1-11 and
N-7). Read only: nothing is ever written to the device here; the advice is data the frontend turns into one row,
and only the user's tap writes (through power_set).

main.py's watch loop calls tick(ctx, power.game_now(ctx)) every 2 s; tick samples every SAMPLE_S, only while a game
runs with TDP control on and the advisor on, through readouts.cheap (no GPU clock read: they wake the GPU). Stats are
kept per app and per bucket "<pl1_w>|ac" / "<pl1_w>|bat" in /run/oxp3deck/sampler-run.json (cleared at a new boot);
dismissals in DECKY_PLUGIN_SETTINGS_DIR/advisor.json.
"""
from __future__ import annotations

import collections
import copy
import json
import logging
import math
import os
import re
import threading
import time

from . import context, readouts, sysexec

log = logging.getLogger("oxp3deck")

SAMPLE_S = 5            # one sample per 5 s (the watch loop runs every 2 s; tick rate-limits itself)
LOAD_SKIP_S = 30        # the first 30 s after a game starts, a resume or a profile change are not counted
RING_N = 120            # 10 minutes in memory (T2-4 sparkline later)
MIN_PLAY_S = 300        # advice only after 5 min of samples at the current PL1 and power source
SAVE_S = 60             # /run/oxp3deck/sampler-run.json at most this often (and at a game change)
MAX_APPS = 50           # per-appid stats kept (oldest dropped)
MAX_DISMISSED = 200     # advisor.json entries kept
BUSY_FOR_REASONS = 5    # read throttle reasons only when the GPU was busier than this (it is awake anyway)
PKG_BINS = 61           # 1 W bins, 0..60 W (the last one holds everything above)
BUSY_BINS = 11          # 10 % bins, 0..100 %
RUN_FILE = "sampler-run.json"
ADVISOR_FILE = "advisor.json"
KINDS = ("headroom", "raise", "plug", "cpu")
_APPID = re.compile(r"^\d{1,10}$")

_LOCK = threading.RLock()
_STATES: dict = {}


def _monotonic() -> float:
    return time.monotonic()


class _State:
    def __init__(self, ctx):
        self.st = readouts.new_state()
        self.prev_t: float | None = None        # the last sample (monotonic)
        self.ctx_key: tuple | None = None       # (app, pl1_w, ac) of the last sample
        self.skip_until: float | None = None
        self.last_busy: float | None = None
        self.ring: collections.deque = collections.deque(maxlen=RING_N)
        self.apps: dict = {}                    # appid: {"at": wall time, "buckets": {bucket: stats}}
        self.dirty = False
        self.saved_at: float | None = None
        self.last_app: str | None = None
        self.sampled_at: float | None = None    # the last counted sample (monotonic)
        self.dismissed = context.Settings(os.path.join(ctx.settings_dir, ADVISOR_FILE))
        self._load(ctx)

    def _load(self, ctx) -> None:
        raw = context.read_small(os.path.join(ctx.sys_path(sysexec.RUN_DIR), RUN_FILE), 4_000_000)
        boot = _boot_id(ctx)
        if raw is None or not boot:
            return
        try:
            got = json.loads(raw.decode("utf-8"))
        except ValueError:
            return
        if not isinstance(got, dict) or got.get("boot_id") != boot or not isinstance(got.get("apps"), dict):
            return
        for appid, rec in got["apps"].items():
            if isinstance(appid, str) and _APPID.match(appid) and isinstance(rec, dict) \
                    and isinstance(rec.get("buckets"), dict) and isinstance(rec.get("at"), (int, float)):
                buckets = {b: v for b, v in rec["buckets"].items() if _bucket_ok(b, v)}
                if buckets:
                    self.apps[appid] = {"at": rec["at"], "buckets": buckets}


def _boot_id(ctx) -> str:
    raw = context.read_small(ctx.sys_path("/proc/sys/kernel/random/boot_id"), 100)
    return raw.decode("utf-8", errors="replace").strip() if raw else ""


def _new_bucket() -> dict:
    return {"secs": 0.0, "n": 0, "pkg_sum": 0.0, "pkg_hist": [0] * PKG_BINS, "busy_sum": 0.0,
            "busy_hist": [0] * BUSY_BINS, "limited_n": 0, "thermal_n": 0, "bat_w_sum": 0.0, "bat_n": 0}


def _bucket_ok(name, b) -> bool:
    if not (isinstance(name, str) and re.fullmatch(r"\d+(\.\d+)?\|(ac|bat)", name) and isinstance(b, dict)):
        return False
    ref = _new_bucket()
    for k, v in ref.items():
        got = b.get(k)
        if isinstance(v, list):
            if not (isinstance(got, list) and len(got) == len(v) and all(isinstance(x, int) for x in got)):
                return False
        elif isinstance(got, bool) or not isinstance(got, (int, float)):
            return False
    return True


def _get(ctx) -> _State:
    s = _STATES.get(ctx.settings_dir)
    if s is None:
        s = _STATES[ctx.settings_dir] = _State(ctx)
    return s


def bucket_name(pl1_w, ac) -> str:
    return f"{pl1_w:g}|{'ac' if ac is True else 'bat'}"


def _save(ctx, s: _State, now: float) -> None:
    blob = (json.dumps({"boot_id": _boot_id(ctx), "apps": s.apps}, sort_keys=True) + "\n").encode()
    try:
        context.write_atomic(os.path.join(sysexec.run_dir(ctx), RUN_FILE), blob, 0o600)
        s.dirty = False
    except OSError as e:
        log.warning("sampler: cannot write the run state (kept in memory): %s", e)
    s.saved_at = now


def _wanted(game: dict) -> bool:
    return bool(game.get("enabled") and game.get("advisor") and game.get("app") and not game.get("blocked")
                and not game.get("overridden") and not game.get("testing") and game.get("slot") != "low"
                and game.get("pl1_w") is not None)


def tick(ctx, game: dict) -> dict:
    """One step of the watch loop: {ok, error, did: "idle" | "skipped" | "sampled"}. game = power.game_now(ctx)."""
    with _LOCK:
        s = _get(ctx)
        now = _monotonic()
        app = game.get("app")
        if app != s.last_app:
            if s.dirty:
                _save(ctx, s, now)              # a game change saves at once
            s.last_app = app
        if not _wanted(game):
            s.prev_t = None                     # the next sample starts a new baseline
            s.ctx_key = None
            return {"ok": True, "error": None, "did": "idle"}
        key = (app, game["pl1_w"], game.get("ac"))
        if key != s.ctx_key or game.get("grace"):
            # a game start, a profile or charger change, a resume: wait until it has settled
            s.skip_until = now + LOAD_SKIP_S
            s.ctx_key = key
        if s.prev_t is not None and now - s.prev_t < SAMPLE_S:
            return {"ok": True, "error": None, "did": "idle"}
        dt = None if s.prev_t is None else now - s.prev_t
        if dt is None or not 0.5 * SAMPLE_S <= dt <= 3 * SAMPLE_S:
            s.st = readouts.new_state()         # a stall or a resume: a new baseline
            readouts.cheap(ctx, s.st, reasons=False)
            s.prev_t = now
            return {"ok": True, "error": None, "did": "skipped"}
        smp = readouts.cheap(ctx, s.st, reasons=s.last_busy is not None and s.last_busy > BUSY_FOR_REASONS)
        s.prev_t = now
        s.last_busy = smp.get("gpu_busy_pct")
        if (s.skip_until is not None and now < s.skip_until) or smp.get("package_w") is None \
                or smp.get("gpu_busy_pct") is None:
            return {"ok": True, "error": None, "did": "skipped"}
        _count(s, app, game, smp, dt)
        s.sampled_at = now
        if s.saved_at is None or now - s.saved_at >= SAVE_S:
            _save(ctx, s, now)
        return {"ok": True, "error": None, "did": "sampled"}


def _count(s: _State, app: str, game: dict, smp: dict, dt: float) -> None:
    rec = s.apps.get(app)
    if rec is None:
        rec = s.apps[app] = {"at": time.time(), "buckets": {}}
        if len(s.apps) > MAX_APPS:
            for old in sorted(s.apps, key=lambda a: s.apps[a]["at"])[:len(s.apps) - MAX_APPS]:
                del s.apps[old]
    rec["at"] = time.time()
    b = rec["buckets"].setdefault(bucket_name(game["pl1_w"], game.get("ac")), _new_bucket())
    pkg, busy = smp["package_w"], smp["gpu_busy_pct"]
    reasons = set(smp.get("reasons") or [])
    b["secs"] = round(b["secs"] + dt, 1)
    b["n"] += 1
    b["pkg_sum"] = round(b["pkg_sum"] + pkg, 2)
    b["pkg_hist"][min(PKG_BINS - 1, max(0, int(pkg)))] += 1
    b["busy_sum"] = round(b["busy_sum"] + busy, 1)
    b["busy_hist"][min(BUSY_BINS - 1, max(0, int(busy // 10)))] += 1
    if reasons & {"pl1", "pl2"} or pkg >= game["pl1_w"] - 1:
        b["limited_n"] += 1
    if reasons & {"thermal", "prochot"} or (smp.get("cpu_throttle_ms") or 0) > 0:
        b["thermal_n"] += 1
    if smp.get("battery_status") == "Discharging" and smp.get("battery_w") is not None:
        b["bat_w_sum"] = round(b["bat_w_sum"] + smp["battery_w"], 2)
        b["bat_n"] += 1
    s.ring.append((round(smp["t"], 1), pkg, busy))
    s.dirty = True


# ---- advice ------------------------------------------------------------------------------------------------------

def _p90(hist: list[int], width: float, top: float) -> float:
    """The upper edge of the bin that holds the 90th percentile."""
    n = sum(hist)
    if not n:
        return 0.0
    need = math.ceil(0.9 * n)
    run = 0
    for i, c in enumerate(hist):
        run += c
        if run >= need:
            return min(top, (i + 1) * width)
    return top


def stats(b: dict) -> dict:
    n = b["n"] or 1
    return {"samples": b["n"], "avg_package_w": round(b["pkg_sum"] / n, 1),
            "p90_package_w": _p90(b["pkg_hist"], 1, PKG_BINS),
            "avg_gpu_busy_pct": round(b["busy_sum"] / n, 1), "p90_gpu_busy_pct": _p90(b["busy_hist"], 10, 100),
            "limited_share": round(b["limited_n"] / n, 3), "thermal_share": round(b["thermal_n"] / n, 3)}


def _advise(bucket: dict, game: dict) -> dict | None:
    """The advice for one bucket (pure): None before MIN_PLAY_S or when nothing applies. game: power.game_now's
    pl1_w (the bucket's), pl1_min, pl1_max, pl1_max_ac, ac."""
    if not bucket or bucket["secs"] < MIN_PLAY_S or not bucket["n"]:
        return None
    pl1 = game.get("pl1_w")
    pl1_max = game.get("pl1_max")
    if pl1 is None or pl1_max is None:
        return None
    st = stats(bucket)
    limited = bucket["limited_n"] / bucket["n"]
    busy_mean = bucket["busy_sum"] / bucket["n"]
    kind = suggest = None
    if limited < 0.10 and st["p90_gpu_busy_pct"] < 85 and st["p90_package_w"] <= pl1 - 4:
        s = max(game.get("pl1_min") or 5, min(pl1 - 3, math.ceil(st["p90_package_w"]) + 2))
        if pl1 - s >= 3:
            kind, suggest = "headroom", int(s)
    elif limited >= 0.50 and busy_mean >= 90:
        if pl1 <= pl1_max - 2:
            kind, suggest = "raise", int(min(pl1_max, pl1 + 5))
        elif game.get("ac") is False and (game.get("pl1_max_ac") or 0) > pl1:
            kind = "plug"
        else:
            kind = "cpu"
    if kind is None:
        return None
    return {"kind": kind, "pl1_w": pl1, "suggest_w": suggest, "ac": game.get("ac") is True,
            "pl1_max_ac": game.get("pl1_max_ac"), "seconds": int(bucket["secs"]), "stats": st}


def _norm_appid(appid):
    if isinstance(appid, int) and not isinstance(appid, bool):
        appid = str(appid)
    return appid if isinstance(appid, str) and _APPID.match(appid) else None


def _dismissed(s: _State) -> dict:
    d = s.dismissed.get("dismissed")
    return d if isinstance(d, dict) else {}


def advice(ctx, appid) -> dict:
    """PowerAdviceRes: {ok, error, advice: PowerAdvice | null, sampling, seconds, need_s}. In memory only (the
    context from power.game_now, which reads no sysfs)."""
    from . import power
    with _LOCK:
        s = _get(ctx)
        app = _norm_appid(appid)
        if app is None:
            return {"ok": False, "error": f"power_advice: {appid!r} is not a Steam app id", "advice": None,
                    "sampling": False, "seconds": 0, "need_s": MIN_PLAY_S}
        game = power.game_now(ctx)
        now = _monotonic()
        running = game.get("app") == app
        sampling = running and _wanted(game) and s.sampled_at is not None and now - s.sampled_at <= 3 * SAMPLE_S
        rec = s.apps.get(app) or {}
        bucket = None
        if running and game.get("pl1_w") is not None:
            bucket = (rec.get("buckets") or {}).get(bucket_name(game["pl1_w"], game.get("ac")))
        out = {"ok": True, "error": None, "advice": None, "sampling": bool(sampling),
               "seconds": int(bucket["secs"]) if bucket else 0, "need_s": MIN_PLAY_S}
        if not running or not _wanted(game) or bucket is None:
            return out
        a = _advise(bucket, game)
        if a is None:
            return out
        d = _dismissed(s).get(app)
        if isinstance(d, dict) and d.get("kind") == a["kind"] and d.get("pl1_w") == a["pl1_w"]:
            return out
        out["advice"] = dict(a, appid=app)
        return out


def dismiss(ctx, appid, kind, pl1_w) -> dict:
    """{ok, error}: the (kind, pl1_w) advice for the app is not shown again (advisor.json)."""
    with _LOCK:
        s = _get(ctx)
        app = _norm_appid(appid)
        if app is None:
            return {"ok": False, "error": f"power_advice_dismiss: {appid!r} is not a Steam app id"}
        if kind not in KINDS:
            return {"ok": False, "error": f"power_advice_dismiss: kind must be one of {', '.join(KINDS)}"}
        if isinstance(pl1_w, bool) or not isinstance(pl1_w, (int, float)) or not 0 < pl1_w <= 200:
            return {"ok": False, "error": "power_advice_dismiss: pl1_w must be a number of watts"}
        d = copy.deepcopy(_dismissed(s))
        d[app] = {"kind": kind, "pl1_w": pl1_w, "at": time.time()}
        if len(d) > MAX_DISMISSED:
            for old in sorted(d, key=lambda a: d[a].get("at") or 0)[:len(d) - MAX_DISMISSED]:
                del d[old]
        err = s.dismissed.replace({"version": 1, "dismissed": d})
        return {"ok": err is None, "error": err}


def report(ctx) -> dict:
    """The per-app stats (with the derived figures), for diagnose."""
    with _LOCK:
        s = _get(ctx)
        return {"apps": {a: {"at": r["at"], "buckets": {b: dict(stats(v), secs=v["secs"])
                                                        for b, v in r["buckets"].items()}}
                         for a, r in s.apps.items()},
                "dismissed": copy.deepcopy(_dismissed(s))}
