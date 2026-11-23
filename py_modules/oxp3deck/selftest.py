"""The device self-test and the 60 s power measurement (DESIGN.md "Performance batch" B, ROADMAP N-2 and the read
part of N-5). Both run as jobs (main.py power_selftest / power_measure).

The self-test moves each power control OXP3 Deck manages by one small step, reads what the device took and puts the
value read just before back at once, through power.probe (atomic under power.py's lock: nothing else ever sees a
probe value). It never leaves anything changed: power.selftest_mark(False) re-applies the profile in a finally.
The measurement is read only (readouts.cheap every MEASURE_STEP_S for MEASURE_S).

Results persist in DECKY_PLUGIN_SETTINGS_DIR/selftest.json: {"version": 1, "test": SelftestResult | null,
"measures": [MeasureResult, ...]} (newest first, at most KEEP_MEASURES).
"""
from __future__ import annotations

import logging
import os
import threading
import time

from . import context, power, powerhw, readouts

log = logging.getLogger("oxp3deck")

PROBE_W = 1                 # RAPL step (W)
PROBE_MHZ = 50              # GPU step
PROBE_PCT = 5               # max_perf_pct step (min_perf_pct: 1)
PROBE_CAP_MHZ = 200         # per-core cap step
MEASURE_S = 60
MEASURE_STEP_S = 2
MEASURE_MIN_S = 20          # an interrupted measurement shorter than this is not stored
KEEP_MEASURES = 10
VERSION = 1
FILE = "selftest.json"
OUTCOMES = ("ok", "locked", "ignored", "unsupported", "skipped", "not_restored")

_LOCK = threading.Lock()
_STOP = threading.Event()   # set by stop() when the plugin unloads: run_test ends before the next probe
_IDLE = threading.Event()   # clear while run_test runs (its finally included)
_IDLE.set()
_STORES: dict = {}

_sleep = time.sleep          # patched in tests


def _monotonic() -> float:
    return time.monotonic()


def _store(ctx) -> context.Settings:
    with _LOCK:
        s = _STORES.get(ctx.settings_dir)
        if s is None:
            s = _STORES[ctx.settings_dir] = context.Settings(os.path.join(ctx.settings_dir, FILE))
        return s


def _stored(ctx) -> dict:
    """selftest.json as this code knows it (a bad file reads as empty)."""
    raw = _store(ctx).all()
    test = raw.get("test") if isinstance(raw.get("test"), dict) else None
    measures = [m for m in raw.get("measures") or [] if isinstance(m, dict)] \
        if isinstance(raw.get("measures"), list) else []
    return {"version": VERSION, "test": test, "measures": measures[:KEEP_MEASURES]}


def _save(ctx, data: dict) -> str | None:
    err = _store(ctx).replace(data)
    if err:
        log.warning("selftest: %s", err)
    return err


def _text(ctx, path: str) -> str | None:
    raw = context.read_small(ctx.sys_path(path), 4096)
    if raw is None:
        return None
    return raw.decode("utf-8", errors="replace").strip() or None


# ---- when it may run ---------------------------------------------------------------------------------------------

def precheck(ctx, what: str, mode: str | None = None) -> str | None:
    """Why not now (None: go). what "test" or "measure" (mode "idle" or "game"). The job runner already refuses a
    second job."""
    g = power.game_now(ctx)
    if what == "test":
        if not g["enabled"]:
            return "Turn on power control first."
        if g["blocked"]:
            return f"Power control is paused: {g['blocked']}"
        if g["overridden"]:
            return "Something else changes the power limits: take control first."
        if g["app"]:
            return "Quit the game first."
        if g["grace"]:
            return "The charger just changed: wait 20 s and try again."
        return None
    if what == "measure":
        if mode not in ("idle", "game"):
            return f"power_measure: mode must be 'idle' or 'game', not {mode!r}"
        if mode == "game" and not g["app"]:
            return "Start the game first."
        if mode == "idle" and g["app"]:
            return "A game is running: tap Measure 60 s again to measure it."
        return None
    return f"selftest: unknown check {what!r}"


# ---- the self-test -----------------------------------------------------------------------------------------------

def run_test(ctx, job) -> dict:
    """{ok, error, selftest: SelftestResult}. Stops when a game starts, the charger changes or the device resumes;
    whatever happens, power.selftest_mark(False) re-applies the profile and the result is stored."""
    why = precheck(ctx, "test")
    if why:
        return {"ok": False, "error": why, "selftest": None}
    probes: list[dict] = []
    stopped = None
    windows: dict = {}
    reapplied = None
    start = power.game_now(ctx)
    _IDLE.clear()
    power.selftest_mark(ctx, True)
    try:
        plan = power.probe_plan(ctx)
        job.say(f"{sum(1 for i in plan if not i.get('skip'))} controls to check")
        for item in plan:
            g = power.game_now(ctx)
            if g["app"]:
                stopped = "A game started: stopped. Everything is back as it was."
                break
            if g["grace"] or g["ac"] != start["ac"]:
                stopped = "The charger changed: stopped. Run it again."
                break
            if not (g["enabled"] and not g["blocked"] and not g["overridden"]):
                stopped = "Power control was paused: stopped. Everything is back as it was."
                break
            if _STOP.is_set():
                stopped = "The plugin is stopping: stopped. Everything is back as it was."
                break
            row = power.probe(ctx, item)
            probes.append(row)
            job.say(f"{row['label']}: {row['outcome']}" + (f" ({row['why']})" if row.get("why") else ""))
        windows = power.time_windows(ctx)
    except Exception as e:
        log.exception("selftest: the check failed")
        stopped = f"Stopped by an error: {type(e).__name__}: {e}. Everything is back as it was."
    finally:
        try:
            reapplied = power.selftest_mark(ctx, False).get("applied")
        except Exception:
            log.exception("selftest: re-applying the profile failed")
        _IDLE.set()
    result = {"at": time.time(), "kernel": _text(ctx, "/proc/sys/kernel/osrelease"),
              "bios": _text(ctx, "/sys/class/dmi/id/bios_version"), "probes": probes, "time_windows": windows,
              "stopped": stopped, "reapplied": reapplied}
    data = _stored(ctx)
    data["test"] = result
    err = _save(ctx, data)
    if err:
        job.say(f"Not saved: {err}")
    if stopped:
        job.say(stopped)
        return {"ok": False, "error": stopped, "selftest": result}
    works = sum(1 for r in probes if r["outcome"] == "ok")
    tried = sum(1 for r in probes if r["outcome"] not in ("skipped",))
    job.say(f"{works} of {tried} work")
    return {"ok": True, "error": None, "selftest": result}


def stop(wait_s: float = 1.5) -> bool:
    """The plugin unloads: end a running self-test before its next probe and wait (briefly) for its finally, which
    re-applies the profile, so no probe value is left when Decky kills the process. True when nothing runs now."""
    _STOP.set()
    return _IDLE.wait(wait_s)


# ---- the measurement ---------------------------------------------------------------------------------------------

def _avg(vals: list) -> float | None:
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def summarise(samples: list[dict]) -> dict:
    """The MeasureResult figures of readouts.cheap samples (pure)."""
    pkg = [s["package_w"] for s in samples if s.get("package_w") is not None]
    reasons: dict = {}
    n = len(samples)
    for s in samples:
        for r in set(s.get("reasons") or []):
            reasons[r] = reasons.get(r, 0) + 1
    thr = [s["cpu_throttle_ms"] for s in samples if s.get("cpu_throttle_ms") is not None]
    return {"avg_package_w": _avg(pkg), "max_package_w": round(max(pkg), 1) if pkg else None,
            "avg_gpu_busy_pct": _avg([s.get("gpu_busy_pct") for s in samples]),
            "avg_battery_w": _avg([s.get("battery_w") for s in samples if s.get("battery_status") == "Discharging"]),
            "reasons": {k: round(v / n, 2) for k, v in sorted(reasons.items())} if n else {},
            "cpu_throttle_ms": sum(thr) if thr else None}


def run_measure(ctx, job, mode: str) -> dict:
    """{ok, error, measure: MeasureResult}: read only, no lock. Mode "game" stops when the game ends or changes
    (stored only after at least MEASURE_MIN_S)."""
    why = precheck(ctx, "measure", mode)
    if why:
        return {"ok": False, "error": why, "measure": None}
    g0 = power.game_now(ctx)
    ac = g0["ac"] if g0["ac"] is not None else powerhw.ac_online(ctx)    # no tick yet: one read
    from . import sampler
    st = readouts.new_state()
    # throttle/reasons may wake an idle GPU (xe takes a runtime-PM reference to read it), which would inflate an
    # idle figure: read it while a game runs, or once the GPU was seen busy anyway (the sampler's rule)
    busy = None
    readouts.cheap(ctx, st, reasons=mode == "game")  # the baseline of every Δ
    t0 = _monotonic()
    samples: list[dict] = []
    interrupted = None
    job.say("Measuring for 60 s" + (": go back to the game now" if mode == "game" else ""))
    while _monotonic() - t0 < MEASURE_S:
        _sleep(MEASURE_STEP_S)
        if mode == "game":
            g = power.game_now(ctx)
            if g["app"] != g0["app"]:
                interrupted = "the game ended"
                break
        smp = readouts.cheap(ctx, st, reasons=mode == "game" or (busy is not None
                                                                and busy > sampler.BUSY_FOR_REASONS))
        busy = smp.get("gpu_busy_pct")
        samples.append(smp)
    seconds = int(round(min(_monotonic() - t0, MEASURE_S)))
    if interrupted and seconds < MEASURE_MIN_S:
        text = f"The game ended after {seconds} s: not stored (a measurement needs {MEASURE_MIN_S} s)."
        job.say(text)
        return {"ok": False, "error": text, "measure": None}
    result = {"at": time.time(), "mode": mode, "appid": g0["app"] if mode == "game" else None,
              "name": g0.get("name") if mode == "game" else None, "seconds": seconds, "ac": ac,
              "profile": g0["key"], "slot": g0["slot"], "pl1_w": g0["pl1_w"], "pl2_w": g0.get("pl2_w"),
              **summarise(samples), "interrupted": interrupted}
    data = _stored(ctx)
    data["measures"] = [result] + data["measures"][:KEEP_MEASURES - 1]
    err = _save(ctx, data)
    if err:
        job.say(f"Not saved: {err}")
    job.say(f"{result['avg_package_w']} W average, {result['max_package_w']} W peak, GPU "
            f"{result['avg_gpu_busy_pct']} %")
    return {"ok": True, "error": None, "measure": result}


# ---- answers -----------------------------------------------------------------------------------------------------

def info(ctx) -> dict:
    """PowerSelftestInfo (for power.info): what is stored; no hardware read."""
    data = _stored(ctx)
    return {"test": data["test"], "measures": data["measures"], "measured": bool(data["measures"])}


def report(ctx) -> dict:
    """Everything stored plus the sampler's per-app stats, for the diagnose sidecar (JSON-safe)."""
    out = {"selftest": _stored(ctx)}
    try:
        from . import sampler
        out["sampler"] = sampler.report(ctx)
    except Exception as e:
        out["sampler"] = {"error": f"{type(e).__name__}: {e}"}
    return out
