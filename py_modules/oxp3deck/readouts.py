"""Live readouts for the Power section (DESIGN.md "Live readouts"): package power, battery draw and time left, CPU
temperature, GPU busy and clocks, why it is slow, fan RPM. Read only: no settings, no writes, no lock shared with
power.py. main.py's power_live calls sample() about every second while a panel shows (the GPU clock reads wake the
GPU).

Every sensor is found by name, never by number (hwmon and RAPL numbering changes between boots); the discovery is
cached per ctx.root and redone when a cached path stops reading. Every path goes through ctx.sys_path().
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time

from . import powerhw

log = logging.getLogger("oxp3deck")

POWERCAP = "/sys/class/powercap"
POWER_SUPPLY = "/sys/class/power_supply"
HWMON = "/sys/class/hwmon"
CPU0_THROTTLE = "/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_total_time_ms"
MIN_DT_S, MAX_DT_S = 0.2, 30.0      # a power or busy figure needs two samples this far apart
MIN_DRAW_W = 0.5                    # below this, time left / to full is not shown
REDISCOVER_S = 30                   # also look again this often (a sensor whose driver loads later)
_MSR_ZONE = re.compile(r"^intel-rapl:\d+$")

_LOCK = threading.Lock()
_STATES: dict = {}


def _monotonic() -> float:
    return time.monotonic()


def _read(path: str | None) -> str | None:
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            return f.read(4096).decode("utf-8", errors="replace").strip()
    except OSError:
        return None


def _int(text: str | None) -> int | None:
    if text is None:
        return None
    try:
        return int(text.split()[0]) if text.split() else None
    except ValueError:
        return None


def _entries(path: str) -> list[str]:
    try:
        with os.scandir(path) as it:
            return sorted(e.name for e in it)
    except OSError:
        return []


class _State:
    def __init__(self):
        self.found: dict | None = None
        self.found_at = 0.0
        self.prev: dict = {}             # name: (monotonic time, value) of the last sample


def _get(ctx) -> _State:
    s = _STATES.get(ctx.root)
    if s is None:
        s = _STATES[ctx.root] = _State()
    return s


# ---- discovery (by name) -----------------------------------------------------------------------------------------

def _find_zone(ctx) -> dict | None:
    """The MSR RAPL zone named package-0 (never MMIO: both count the same energy)."""
    base = ctx.sys_path(POWERCAP)
    for zid in _entries(base):
        path = os.path.join(base, zid)
        if _MSR_ZONE.match(zid) and _read(os.path.join(path, "name")) == "package-0":
            return {"energy": os.path.join(path, "energy_uj"), "range": os.path.join(path, "max_energy_range_uj")}
    return None


def _find_battery(ctx) -> str | None:
    base = ctx.sys_path(POWER_SUPPLY)
    for name in _entries(base):
        if _read(os.path.join(base, name, "type")) == "Battery":
            return os.path.join(base, name)
    return None


def _find_hwmon(ctx, name: str) -> str | None:
    base = ctx.sys_path(HWMON)
    for h in _entries(base):
        if _read(os.path.join(base, h, "name")) == name:
            return os.path.join(base, h)
    return None


def _find_temp(ctx) -> str | None:
    """coretemp's "Package id 0" input, else its temp1_input."""
    hw = _find_hwmon(ctx, "coretemp")
    if hw is None:
        return None
    for f in _entries(hw):
        m = re.match(r"^temp(\d+)_label$", f)
        if m and _read(os.path.join(hw, f)) == "Package id 0":
            return os.path.join(hw, f"temp{m.group(1)}_input")
    return os.path.join(hw, "temp1_input")


def _find_gpu(ctx, known: str | None = None) -> str | None:
    """The render GT's freq0 folder. A known one that still exists is kept: the full discovery reads gtidle/name and
    rpe_freq, which wake the GPU."""
    if known and os.path.isdir(known):
        return known
    g = powerhw._discover_gpu(ctx, [])
    return g["path"] if g else None


def _find_fan(ctx) -> str | None:
    hw = _find_hwmon(ctx, "oxp_ec")          # kernel 7.4+ on the ONEXPLAYER 3
    return os.path.join(hw, "fan1_input") if hw else None


def _discover(ctx, old: dict | None = None) -> dict:
    return {"zone": _find_zone(ctx), "battery": _find_battery(ctx), "temp": _find_temp(ctx),
            "gpu": _find_gpu(ctx, (old or {}).get("gpu")), "fan": _find_fan(ctx),
            "throttle": ctx.sys_path(CPU0_THROTTLE)}


def _stale(found: dict) -> bool:
    """A cached path that stops reading: look again (a module reloaded, a hwmon renumbered). The GPU by rp0_freq,
    whose show takes no runtime-PM guard (act_freq would wake the GPU once more per sample)."""
    checks = [(found.get("zone") or {}).get("energy"), found.get("temp"), found.get("fan"),
              os.path.join(found["battery"], "status") if found.get("battery") else None,
              os.path.join(found["gpu"], "rp0_freq") if found.get("gpu") else None]
    return any(path is not None and _read(path) is None for path in checks)


# ---- values ------------------------------------------------------------------------------------------------------

def _delta(st: _State, name: str, now: float, value: int | None, wrap: int | None = None) -> tuple | None:
    """(Δvalue, Δt) since the last sample of `name`, or None (first sample, too close, too far, unreadable)."""
    prev = st.prev.get(name)
    if value is None:
        st.prev.pop(name, None)
        return None
    st.prev[name] = (now, value)
    if prev is None:
        return None
    dt = now - prev[0]
    if dt < MIN_DT_S or dt > MAX_DT_S:
        return None
    dv = value - prev[1]
    if dv < 0:
        if not wrap:
            return None
        dv += wrap
    return dv, dt


def _package_w(st: _State, found: dict, now: float) -> float | None:
    zone = found.get("zone")
    if not zone:
        return None
    d = _delta(st, "energy", now, _int(_read(zone["energy"])), _int(_read(zone["range"])))
    if d is None:
        return None
    return round(d[0] / d[1] / 1e6, 1)


def _battery(found: dict) -> dict | None:
    path = found.get("battery")
    if not path:
        return None

    def num(name):
        return _int(_read(os.path.join(path, name)))

    status = _read(os.path.join(path, "status")) or "Unknown"
    power = num("power_now")
    current, voltage = num("current_now"), num("voltage_now")
    draw = None
    if power is not None:
        draw = abs(power) / 1e6
    elif current is not None and voltage is not None:
        draw = abs(current) * voltage / 1e12
    left = full = None
    if draw is not None and draw >= MIN_DRAW_W:
        end = num("charge_control_end_threshold")
        end = end if end is not None and 0 < end <= 100 else 100
        if power is not None and num("energy_now") is not None:
            have, top, rate = num("energy_now"), num("energy_full"), abs(power)
        elif current is not None and num("charge_now") is not None:
            have, top, rate = num("charge_now"), num("charge_full"), abs(current)
        else:
            have = top = rate = None
        if have is not None and rate:
            if status == "Discharging":
                left = int(have / rate * 60)
            elif status == "Charging" and top:
                need = top * end / 100 - have
                full = max(0, int(need / rate * 60))
    return {"status": status, "percent": num("capacity"), "draw_w": round(draw, 1) if draw is not None else None,
            "time_left_min": left, "time_to_full_min": full}


def _temp(found: dict) -> float | None:
    milli = _int(_read(found.get("temp")))
    return round(milli / 1000, 1) if milli is not None else None


def _gpu(st: _State, found: dict, now: float) -> dict | None:
    path = found.get("gpu")
    if not path:
        return None
    busy = None
    d = _delta(st, "idle", now, _int(_read(os.path.join(os.path.dirname(path), "gtidle", "idle_residency_ms"))))
    if d is not None:
        busy = int(round(max(0.0, min(100.0, 100 - 100 * d[0] / (d[1] * 1000)))))
    text = _read(os.path.join(path, "throttle", "reasons")) or ""
    reasons = [r[len("reason_"):] if r.startswith("reason_") else r
               for r in re.split(r"[\s,]+", text) if r and r != "none"]
    return {"busy_pct": busy, "cur_mhz": _int(_read(os.path.join(path, "cur_freq"))),
            "act_mhz": _int(_read(os.path.join(path, "act_freq"))), "reasons": reasons}


def _throttle(st: _State, found: dict, now: float, gpu: dict | None) -> dict:
    ms = _int(_read(found.get("throttle")))
    prev = st.prev.get("throttle")
    st.prev["throttle"] = (now, ms) if ms is not None else None
    delta = None
    if ms is not None and prev is not None and prev[1] is not None and ms >= prev[1]:
        delta = ms - prev[1]
    return {"cpu_ms": delta, "cpu": bool(delta), "gpu": list((gpu or {}).get("reasons") or [])}


def sample(ctx) -> dict:
    """{ok, error, live: Live}; never raises."""
    try:
        with _LOCK:
            st = _get(ctx)
            now = _monotonic()
            if st.found is None or now - st.found_at >= REDISCOVER_S or _stale(st.found):
                st.found, st.found_at = (_discover(ctx) if st.found is None or _stale(st.found)
                                         else _discover(ctx, st.found)), now
            found = st.found
            gpu = _gpu(st, found, now)
            live = {"t": time.time(), "package_w": _package_w(st, found, now), "battery": _battery(found),
                    "cpu_temp_c": _temp(found), "gpu": gpu, "throttle": _throttle(st, found, now, gpu),
                    "fan_rpm": _int(_read(found.get("fan")))}
            return {"ok": True, "error": None, "live": live}
    except Exception as e:
        log.exception("readouts: sample failed")
        return {"ok": False, "error": f"live readouts failed: {e}", "live": None}
