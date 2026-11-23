"""Power control: profiles, settings, the boot snapshot, events (game, AC, resume), drift and conflicts with other
power managers. powerhw.py does the sysfs reads and writes. Answers are in W and MHz. See DESIGN.md
"Power (TDP, GPU, CPU)".

State is one _Power object per ctx.settings_dir. Every public function holds the module's RLock around its
read-decide-write, and runs in an executor thread (main.py's _call and its watch task), never on the event loop.
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

from . import context, powerhw, sysexec

log = logging.getLogger("oxp3deck")

MIN_W = 5
MAX_W = 100                      # what a profile may store (W); apply clamps to the range of the moment
MAX_MHZ = 5000
OXP3_BATTERY_W, OXP3_AC_W = 35, 40
OXP3_PL2_W = 52                  # the OXP3's firmware boost (BIOS 5.09, both interfaces): its ceiling, as a constant
                                 # because the registers can hold another tool's leftovers
MAX_PROFILES = 500
MAX_NAME = 128
TICK_S = 2                       # main.py's watch loop period
AC_DEBOUNCE_S, RESUME_DELAY_S, RESUME_VERIFY_S, GRACE_S = 2, 3, 10, 20
GRACE_REAPPLIES = 3
BOOTTIME_JUMP_S = 2.0
CONFLICT_RECHECK_S = 60
SDTDP_MAX_BYTES = 1_000_000
VERSION = 1
SETTINGS_FILE = "power.json"
RUN_FILE = "power-run.json"
OXP3_VENDOR, OXP3_PRODUCT = "ONE-NETBOOK", "ONEXPLAYER 3"   # main.py's _device

EPP_CHOICES = powerhw.EPP_CHOICES
FIELDS = ("pl1_w", "pl2_w", "gpu_min_mhz", "gpu_max_mhz", "epp", "turbo",
          "cpu_max_pct", "cpu_min_pct", "soc_balance", "soc_offset", "gpu_power_profile",
          "cpu_cap_p_mhz", "cpu_cap_e_mhz", "cpu_cap_lpe_mhz", "epp_p", "epp_e", "epp_lpe", "fan_mode", "scx_mode",
          "pl2_follow")
CORE_TYPES = powerhw.CORE_TYPES
CAP_FIELDS = tuple(f"cpu_cap_{t}_mhz" for t in CORE_TYPES)
EPP_TYPE_FIELDS = tuple(f"epp_{t}" for t in CORE_TYPES)
# int fields: (low, high, unit) of what a profile may store
_INT_BOUNDS = {"pl1_w": (MIN_W, MAX_W, "W"), "pl2_w": (MIN_W, MAX_W, "W"), "gpu_min_mhz": (0, MAX_MHZ, "MHz"),
               "gpu_max_mhz": (0, MAX_MHZ, "MHz"), "cpu_max_pct": (30, 100, "%"), "cpu_min_pct": (1, 50, "%"),
               "soc_balance": (1, 5, ""), "soc_offset": (0, 3, ""),
               **{f: (400, 6000, "MHz") for f in CAP_FIELDS}}
_CHOICE_FIELDS = {"epp": EPP_CHOICES, **{f: EPP_CHOICES for f in EPP_TYPE_FIELDS},
                  "gpu_power_profile": powerhw.GPU_PROFILES, "fan_mode": ("auto", "quiet", "max"),
                  "scx_mode": ("auto", "gaming", "powersave")}
CPU_PCT_MIN, CPU_MIN_PCT_MAX = 30, 50
# pl2_follow (T1-1, opt-in, null = off): with pl1_w set and pl2_w null, boost = sustained × this, at most pl2_max and
# never below sustained. It only trims the burst after a load (RAPL averages PL1 over the time window), so it is not a
# battery feature.
PL2_FOLLOW = {"battery": 1.25, "ac": 1.5}
EXCLUSIVE = "use either the CPU speed cap or the per-core caps, not both"
OPTION_DEFAULTS = {"per_game": True, "split_ac": False, "extended": False, "poll_s": 2,
                   "low_battery": True, "low_battery_pct": 20, "low_battery_games": False, "advisor": True}
POLL_MAX_S = 60                  # poll_s: 0 (Off) or 2..POLL_MAX_S
LOW_PCT_MIN, LOW_PCT_MAX = 5, 50  # low_battery_pct
LOW_HYST_PCT = 5                 # the low slot ends at low_battery_pct + this (or on AC)
LOW_CHECK_S = 30                 # the battery's charge is read this often (and at once after an AC change)
# The Battery preset (src/power.ts presetValues("battery", ...) for the low slot; tests/fixtures/power/presets.json
# keeps the two equal): the low-battery slot's values while profiles.default.low is null. Other fields null.
BATTERY_PRESET = {"pl1_w": 10, "pl2_w": 15, "epp": "balance_power", "turbo": False,
                  "gpu_power_profile": "power_saving"}
GAME_POLL_S = 10       # drift-check period while a game runs, no panel shows and nothing was unsettled lately
PANEL_RECENT_S = 10    # a power_state call within this long = a panel shows
CALM_S = 120           # after a drift (even seen once), an apply, a pending retry: poll_s again for this long
PENDING_RETRIES = 30             # transient failures (the GPU asleep) retried at most this often per apply
_APPID = re.compile(r"^\d{1,10}$")

STEAM_FIX = ("Steam's own Performance settings: in Quick Access → Performance, turn off \"TDP limit\" and "
             "\"Manual GPU clock\".")

# id: (name, kind, ignorable, why, fix). Detection is in _scan. `fix` is the do-it-yourself guidance (the UI shows it
# in Details); FIXABLE below is what "Fix for me" may do instead.
CONFLICTS = {
    "simpledeckytdp": ("SimpleDeckyTDP", "blocks", False,
                       "the SimpleDeckyTDP plugin is enabled in Decky: it writes the same power limits",
                       "Decky → Settings → Plugins: disable or uninstall SimpleDeckyTDP (Power tab → Import first)"),
    "powercontrol": ("PowerControl", "blocks", False,
                     "this Decky plugin is enabled: it writes the same power limits",
                     "Decky → Settings → Plugins: disable or uninstall {name}"),
    "powerstation": ("PowerStation", "blocks", False,
                     "PowerStation is running: it sets the power limits (Steam's TDP slider uses it on Bazzite)",
                     "sudo systemctl disable --now powerstation.service. On Bazzite, Steam's TDP slider uses it, and "
                     "Bazzite's hardware setup turns it back on after a system update"),
    "thermald": ("thermald", "blocks", False,
                 "thermald is running: on this CPU it rewrites the sustained power limit (PL1) within seconds",
                 "sudo systemctl disable --now thermald.service: on this CPU it rewrites the sustained limit within "
                 "seconds. The CPU's own heat limit and the fan curve still protect the device"),
    "hhd": ("Handheld Daemon", "blocks", True,
            "Handheld Daemon is running: its TDP control writes the same power limits",
            "turn off TDP control in Handheld Daemon's settings, then \"I've handled it\""),
    "oxp3-tdp-sync": ("oxp3-tdp-sync", "blocks", False,
                      "oxp3-tdp-sync.service is running: it copies the MMIO PL1 into MSR every 2 s",
                      "sudo systemctl disable --now oxp3-tdp-sync.service (OXP3 Deck writes both)"),
    "onex3-tdp": ("onex3-tdp", "blocks", False, "onex3-tdp.service is running: it sets the power limits",
                  "sudo systemctl disable --now onex3-tdp.service"),
    "steamos-remote": ("Steam's TDP slider (steamos-manager)", "blocks", True,
                       "a steamos-manager remote lets Steam's TDP slider write the power limits",
                       "Steam's TDP slider writes through it: turn Steam's \"TDP limit\" off in Quick Access → "
                       "Performance, then \"I've handled it\""),
    "ppd": ("power-profiles-daemon", "cpu", True,
            "power-profiles-daemon is running: it sets the energy preference (EPP) and the platform profile",
            "sudo systemctl disable --now power-profiles-daemon.service"),
    "tuned": ("tuned", "cpu", True, "tuned is running: it sets the energy preference (EPP) and CPU boost",
              "sudo systemctl disable --now tuned-ppd.service tuned.service"),
    "intel_lpmd": ("intel_lpmd", "cpu", True, "intel_lpmd is running: it sets the energy preference (EPP) and parks "
                   "cores", "sudo systemctl disable --now intel_lpmd.service (CachyOS enables it on this CPU; it sets "
                   "EPP and parks cores, not the power limits)"),
}
# What "Fix for me" may stop and disable, per conflict id: the whole whitelist. No unit name ever comes from the
# frontend or from a file (a record's units are checked against this when read). Never uninstall.
FIXABLE = {
    "powerstation": ("powerstation.service",),
    "thermald": ("thermald.service",),
    "oxp3-tdp-sync": ("oxp3-tdp-sync.service",),
    "onex3-tdp": ("onex3-tdp.service",),
    "ppd": ("power-profiles-daemon.service",),
    "tuned": ("tuned-ppd.service", "tuned.service"),
    "intel_lpmd": ("intel_lpmd.service",),
}
# The FIXABLE units that something else can start again after a stop and disable, so Fix for me also masks them
# (persistently, after the stop; Undo unmasks first): power-profiles-daemon and tuned-ppd are D-Bus activated
# (net.hadess.PowerProfiles / org.freedesktop.UPower.PowerProfiles, SystemdService=<unit>), tuned.service is pulled
# in by tuned-ppd.service (Requires=tuned.service), thermald and intel_lpmd are D-Bus activated through their alias
# (SystemdService=dbus-org.freedesktop.thermald.service / org.freedesktop.intel_lpmd.service). Nothing outside
# FIXABLE is ever masked.
MASKABLE = frozenset({"power-profiles-daemon.service", "tuned-ppd.service", "tuned.service", "thermald.service",
                      "intel_lpmd.service"})
FIX_RECHECK_S = 10               # tick checks the conflicts again this long after a fix (a D-Bus restart)
FIX_TIMEOUT_S = 30               # one systemctl stop / disable / mask / unmask / enable / start
_ACTIVE = ("active", "activating", "reloading")
IGNORABLE = frozenset(k for k, v in CONFLICTS.items() if v[2])
_UNITS = {
    "powerstation": re.compile(r"^powerstation\.service$"),
    "thermald": re.compile(r"^thermald\.service$"),
    "hhd": re.compile(r"^hhd(_local)?(@[^.]*)?\.service$"),
    "oxp3-tdp-sync": re.compile(r"^oxp3-tdp-sync\.service$"),
    "onex3-tdp": re.compile(r"^onex3-tdp\.service$"),
    "ppd": re.compile(r"^power-profiles-daemon\.service$"),
    "tuned": re.compile(r"^tuned(-ppd)?\.service$"),
    "intel_lpmd": re.compile(r"^intel_lpmd\.service$"),
}
_COMMS = {"powerstation": "powerstation", "thermald": "thermald", "hhd": "hhd"}
_PLUGINS = {"SimpleDeckyTDP": "simpledeckytdp", "PowerControl": "powercontrol", "PowerTools": "powercontrol"}
REMOTES = ("/etc/steamos-manager/remotes.d", "/usr/share/steamos-manager/remotes.d")

_LOCK = threading.RLock()
_STATES: dict = {}


def _monotonic() -> float:
    return time.monotonic()


def _clock_gap() -> float | None:
    """CLOCK_BOOTTIME − CLOCK_MONOTONIC: grows by the time spent suspended."""
    try:
        return time.clock_gettime(time.CLOCK_BOOTTIME) - time.clock_gettime(time.CLOCK_MONOTONIC)
    except (AttributeError, OSError):
        return None


# ---- small helpers -----------------------------------------------------------------------------------------------

def _w(uw) -> float | int | None:
    """µW as W, rounded down to 0.125 W; an int when whole."""
    if uw is None:
        return None
    w = math.floor(uw / 125_000) * 0.125
    return int(w) if w == int(w) else w


def _uw(w) -> int:
    return int(round(w * 1_000_000))


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _text(path: str, limit: int = 4096) -> str:
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def _values_ok(name: str, v):
    """(True, normalised value) or (False, why)."""
    if v is None:
        return True, None
    if name in _INT_BOUNDS:
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        if isinstance(v, bool) or not isinstance(v, int):
            return False, f"{name} must be a whole number or null"
        lo, hi, unit = _INT_BOUNDS[name]
        if not lo <= v <= hi:
            return False, f"{name} must be {lo}..{hi}{' ' + unit if unit else ''}"
        return True, v
    if name in _CHOICE_FIELDS:
        choices = _CHOICE_FIELDS[name]
        return (True, v) if isinstance(v, str) and v in choices else \
            (False, f"{name} must be one of {', '.join(choices)} or null")
    if name in ("turbo", "pl2_follow"):
        return (True, v) if isinstance(v, bool) else (False, f"{name} must be true, false or null")
    return False, f"unknown field {name}"


def _empty_values() -> dict:
    return {f: None for f in FIELDS}


def _norm_values(raw, where: str) -> dict:
    out = _empty_values()
    if not isinstance(raw, dict):
        if raw is not None:
            log.warning("power.json: %s is not an object, reads as all firmware values", where)
        return out
    for f in FIELDS:
        ok, v = _values_ok(f, raw.get(f))
        if ok:
            out[f] = v
        else:
            log.warning("power.json: %s.%s = %r reads as null: %s", where, f, raw.get(f), v)
    if _exclusive_broken(out):
        log.warning("power.json: %s has both the CPU speed cap and per-core caps; the per-core caps read as null",
                    where)
        out.update({f: None for f in CAP_FIELDS})
    return out


def follow_pl2(pl1, pl2_max, ac):
    """The boost pl2_follow gives for sustained `pl1` (W): pl1 × 1.5 on AC, × 1.25 on battery or AC unknown, rounded
    half up (as power.ts followPl2), at most pl2_max, never below pl1."""
    k = PL2_FOLLOW["ac" if ac is True else "battery"]
    return max(pl1, min(pl2_max, math.floor(pl1 * k + 0.5)))


def _follows(values: dict) -> bool:
    """pl2_follow is on and can act: sustained power set, boost left to us (an explicit boost wins)."""
    return values.get("pl2_follow") is True and values.get("pl1_w") is not None and values.get("pl2_w") is None


def _exclusive_broken(values: dict) -> bool:
    return values.get("cpu_max_pct") is not None and any(values.get(f) is not None for f in CAP_FIELDS)


def _poll_ok(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and (v == 0 or 2 <= v <= POLL_MAX_S)


def _low_pct_ok(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and LOW_PCT_MIN <= v <= LOW_PCT_MAX


def _option_ok(k: str, v) -> bool:
    if k == "poll_s":
        return _poll_ok(v)
    if k == "low_battery_pct":
        return _low_pct_ok(v)
    return isinstance(v, bool)


def _battery_values() -> dict:
    """The low slot's values while profiles.default.low is null: BATTERY_PRESET, every other field null."""
    return dict(_empty_values(), **BATTERY_PRESET)


def _norm_profile(raw, key: str) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    name = raw.get("name")
    if name is not None and not (isinstance(name, str) and len(name) <= MAX_NAME):
        log.warning("power.json: profile %s has a bad name, reads as none", key)
        name = None
    ac = raw.get("ac")
    out = {"name": name, "main": _norm_values(raw.get("main"), f"{key}.main"),
           "ac": None if ac is None else _norm_values(ac, f"{key}.ac")}
    if key == "default":            # the low-battery slot: the Default profile only
        low = raw.get("low")
        out["low"] = None if low is None else _norm_values(low, "default.low")
    return out


def _norm_data(raw) -> dict:
    """power.json as this code knows it: defaults for anything missing, null for a bad field, bad keys dropped."""
    raw = raw if isinstance(raw, dict) else {}
    data = {"version": VERSION, "enabled": raw.get("enabled") is True}
    for k, default in OPTION_DEFAULTS.items():
        data[k] = raw[k] if _option_ok(k, raw.get(k)) else default
    ignore = raw.get("ignore")
    data["ignore"] = sorted({i for i in ignore if i in IGNORABLE}) if isinstance(ignore, list) else []
    profiles = {"default": _norm_profile((raw.get("profiles") or {}).get("default")
                                        if isinstance(raw.get("profiles"), dict) else None, "default")}
    count = 0
    for key, prof in (raw.get("profiles") or {}).items() if isinstance(raw.get("profiles"), dict) else ():
        if key == "default":
            continue
        if not (isinstance(key, str) and _APPID.match(key)):
            log.warning("power.json: profile key %r dropped", key)
            continue
        if count >= MAX_PROFILES:
            log.warning("power.json: more than %d profiles, %s dropped", MAX_PROFILES, key)
            continue
        profiles[key] = _norm_profile(prof, key)
        count += 1
    data["profiles"] = profiles
    data["fixed"] = _norm_fixed(raw.get("fixed"))
    return data


def _norm_fixed(raw) -> dict:
    """power.json `fixed` (what Fix for me turned off): only FIXABLE ids, only their own units. power.json sits in a
    folder the user owns, so a planted record can at most enable and start a whitelisted unit."""
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for cid, rec in raw.items():
        if not (isinstance(cid, str) and cid in FIXABLE and isinstance(rec, dict)):
            log.warning("power.json: fixed record %r dropped", cid)
            continue
        units, seen = [], set()
        for u in rec.get("units") if isinstance(rec.get("units"), list) else ():
            if not (isinstance(u, dict) and u.get("unit") in FIXABLE[cid] and u["unit"] not in seen
                    and isinstance(u.get("was_enabled"), str) and len(u["was_enabled"]) <= 32
                    and isinstance(u.get("was_active"), bool)):
                log.warning("power.json: fixed record %s: unit entry %r dropped", cid, u)
                continue
            seen.add(u["unit"])
            entry = {"unit": u["unit"], "was_enabled": u["was_enabled"], "was_active": u["was_active"]}
            # was_masked: only on a unit OXP3 Deck masked (always false: it never masks a masked unit), so Undo
            # unmasks it; an older record without it is undone as before (no unmask)
            if u.get("was_masked") is False and u["unit"] in MASKABLE:
                entry["was_masked"] = False
            units.append(entry)
        at = rec.get("at")
        boot = rec.get("boot_id")
        if not units or isinstance(at, bool) or not isinstance(at, (int, float)):
            log.warning("power.json: fixed record %s dropped (no valid units or time)", cid)
            continue
        out[cid] = {"at": at, "boot_id": boot if isinstance(boot, str) and len(boot) <= 64 else "", "units": units}
    return out


def _boot_id(ctx) -> str:
    return _text(ctx.sys_path("/proc/sys/kernel/random/boot_id"), 100)


def _fresh_run(boot: str) -> dict:
    return {"boot_id": boot, "snapshot": None, "app": None, "ours": {}, "locked": [], "overridden": None,
            "suspend_count": None, "low": None}


def _load_run(ctx) -> dict:
    boot = _boot_id(ctx)
    run = _fresh_run(boot)
    raw = context.read_small(os.path.join(ctx.sys_path(sysexec.RUN_DIR), RUN_FILE))
    if raw is None or not boot:
        return run
    try:
        got = json.loads(raw.decode("utf-8"))
    except ValueError:
        return run
    if not isinstance(got, dict) or got.get("boot_id") != boot:
        return run
    snap = got.get("snapshot")
    if isinstance(snap, dict) and isinstance(snap.get("rapl"), dict):
        run["snapshot"] = snap
    if isinstance(got.get("app"), str) and _APPID.match(got["app"]):
        run["app"] = got["app"]
    if isinstance(got.get("ours"), dict):
        run["ours"] = got["ours"]
    if isinstance(got.get("locked"), list):
        run["locked"] = [x for x in got["locked"] if isinstance(x, str)]
    if isinstance(got.get("overridden"), dict):
        run["overridden"] = got["overridden"]
    if isinstance(got.get("suspend_count"), int):
        run["suspend_count"] = got["suspend_count"]
    low = got.get("low")
    if isinstance(low, dict) and isinstance(low.get("since"), (int, float)) and not isinstance(low["since"], bool) \
            and (low.get("pct") is None or (isinstance(low["pct"], int) and not isinstance(low["pct"], bool))):
        run["low"] = {"since": low["since"], "pct": low.get("pct")}
    return run


class _Power:
    def __init__(self, ctx):
        self.store = context.Settings(os.path.join(ctx.settings_dir, SETTINGS_FILE))
        self.data = _norm_data(self.store.all())
        self.hw: dict | None = None
        self.run = _load_run(ctx)
        self.oxp3: bool | None = None
        self.last: dict | None = None        # the last apply (PowerApply)
        self.blocked: str | None = None
        self.rows: list | None = None        # conflicts found by the last check (without `ignored`)
        self.rows_at: float | None = None
        self.loaded: dict = {}               # unit: LOAD column of the last systemctl list-units
        self.recheck_at: float | None = None   # a fix asked tick to look again then (a D-Bus restart)
        self.started = False                 # an apply happened in this process
        self.seen = False                    # tick has run once
        self.prev_susp = self.run.get("suspend_count")
        self.prev_ac = None
        self.prev_gap = None
        self.apply_at: float | None = None
        self.grace_until: float | None = None
        self.grace_left = 0
        self.drift_seen: str | None = None   # the id that differed at the last tick (flagged when seen twice)
        self.run_warned = False
        self.last_poll: float | None = None  # the last drift check (poll_s)
        self.pending: list[str] = []         # ids that failed `transient` at the last apply (the GPU asleep)
        self.pending_left = 0                # retries left for them
        self.game_order: tuple[str, int] | None = None   # the newest power_game order seen (session, seq)
        self.yielded: dict[str, list[str]] = {}   # field group -> the ignored conflicts it was left to (drift)
        self.panel_at: float | None = None   # the last state() call (a panel shows)
        self.unsettled_at: float | None = None   # the last apply, drift sighting or pending retry (N-7)
        self.low_at: float | None = None     # the last battery charge read (low-battery slot)
        self.low_pct: int | None = None      # what it read
        self.testing = False                 # the self-test runs (selftest_mark)


def _get(ctx) -> _Power:
    p = _STATES.get(ctx.settings_dir)
    if p is None:
        p = _STATES[ctx.settings_dir] = _Power(ctx)
    return p


def _hw(ctx, p: _Power) -> dict:
    if p.hw is None:
        p.hw = powerhw.discover(ctx)
    return p.hw


def _is_oxp3(ctx, p: _Power) -> bool:
    if p.oxp3 is None:
        vendor = _text(ctx.sys_path("/sys/class/dmi/id/sys_vendor"), 256)
        product = _text(ctx.sys_path("/sys/class/dmi/id/product_name"), 256)
        p.oxp3 = vendor == OXP3_VENDOR and product == OXP3_PRODUCT
    return p.oxp3


def _save(p: _Power) -> str | None:
    return p.store.replace(copy.deepcopy(p.data))


def _save_run(ctx, p: _Power) -> None:
    blob = (json.dumps(p.run, sort_keys=True) + "\n").encode()
    try:
        context.write_atomic(os.path.join(sysexec.run_dir(ctx), RUN_FILE), blob, 0o600)
    except OSError as e:
        if not p.run_warned:
            log.warning("power: cannot write the run state (kept in memory): %s", e)
            p.run_warned = True


# ---- range, profiles, target -------------------------------------------------------------------------------------

def _boot_rapl(ctx, p: _Power, hw: dict, reading: dict | None) -> dict:
    snap = p.run.get("snapshot")
    if snap and isinstance(snap.get("rapl"), dict):
        return snap["rapl"]
    if reading is None:
        reading = powerhw.read(ctx, hw, gpu=False)
    return reading["rapl"]


def _limits(ctx, p: _Power, hw: dict, ac, reading: dict | None = None) -> dict:
    boot = _boot_rapl(ctx, p, hw, reading)
    zones = hw.get("rapl") or []
    pl1s = [boot.get(z["id"], {}).get("pl1_uw") for z in zones]
    pl2s = [boot.get(z["id"], {}).get("pl2_uw") for z in zones]
    pl1s = [v for v in pl1s if isinstance(v, int) and v > 0]
    pl2s = [v for v in pl2s if isinstance(v, int) and v > 0]
    caps = [z["pl2"]["max_uw"] for z in zones if z.get("pl2") and (z["pl2"].get("max_uw") or 0) > 0]
    oxp3 = _is_oxp3(ctx, p)
    fw_pl2 = OXP3_PL2_W if oxp3 else _w(max(pl2s)) if pl2s else None
    if caps:
        fw_pl2 = _w(min(caps)) if fw_pl2 is None else min(fw_pl2, _w(min(caps)))
    if oxp3:
        bat = OXP3_BATTERY_W if fw_pl2 is None else min(OXP3_BATTERY_W, fw_pl2)
        acw = OXP3_AC_W if fw_pl2 is None else min(OXP3_AC_W, fw_pl2)
        ext = acw if fw_pl2 is None else max(fw_pl2, acw)
    else:
        bat = acw = _w(max(pl1s)) if pl1s else MIN_W
        ext = None
    bat, acw = max(bat, MIN_W), max(acw, MIN_W)
    if ac is True:
        pl1_max = ext if (oxp3 and p.data["extended"] and ext is not None) else acw
    else:
        pl1_max = bat
    pl2_max = max(fw_pl2 if fw_pl2 is not None else pl1_max, pl1_max)
    g = hw.get("gpu")
    snap = p.run.get("snapshot") or {}
    sperf = (snap.get("perf") if "perf" in snap else (reading or {}).get("perf")) or {}
    cpu = hw.get("cpu") or {}
    core_types = {t: {"min_mhz": r["min_mhz"], "max_mhz": r["max_mhz"],
                      "policies": len((cpu.get("types") or {}).get(t) or [])}
                  for t, r in (cpu.get("type_range") or {}).items()}
    return {"pl1_min": MIN_W, "pl1_max": pl1_max, "pl2_max": pl2_max, "pl1_max_battery": bat, "pl1_max_ac": acw,
            "extended_max": ext, "gpu_min": g["rpn"] if g else None, "gpu_max": g["rp0"] if g else None,
            "gpu_efficient": g.get("rpe") if g else None, "spec": "oxp3" if oxp3 else "firmware",
            "cpu_pct_min": CPU_PCT_MIN, "cpu_min_pct_fw": sperf.get("min") if isinstance(sperf.get("min"), int)
            else None, "cpu_min_pct_max": CPU_MIN_PCT_MAX, "core_types": core_types}


def _base_active(p: _Power, ac) -> tuple[str, str, dict]:
    """The profile and slot the user's choices select (no low-battery slot)."""
    data = p.data
    app = p.run.get("app")
    key = app if data["per_game"] and app and app in data["profiles"] else "default"
    prof = data["profiles"][key]
    slot = "ac" if data["split_ac"] and ac is True and prof["ac"] is not None else "main"
    return key, slot, prof[slot]


def _low_held(p: _Power, key: str) -> bool:
    """The low-battery conditions hold but a game's own profile keeps its values."""
    return key != "default" and not p.data["low_battery_games"]


def _low_range(ctx, p: _Power) -> dict | None:
    """The battery range for _merge_low's boost, from the boot snapshot (None before one is taken: no hardware read
    here)."""
    if ctx is None or not p.run.get("snapshot") or p.hw is None:
        return None
    try:
        return _limits(ctx, p, p.hw, False)
    except Exception:
        log.exception("power: battery range")
        return None


def _active(p: _Power, ac, ctx=None) -> tuple[str, str, dict]:
    """(profile key, slot, values) of what runs: the low-battery slot ("low", merged values) while run.low is set,
    for the Default profile (or every profile with low_battery_games). ctx: for the battery range of the low slot's
    boost (_low_range)."""
    key, slot, values = _base_active(p, ac)
    if p.run.get("low") and p.data["low_battery"] and not _low_held(p, key):
        low = p.data["profiles"]["default"].get("low")
        return key, "low", _merge_low(p, values, low if low is not None else _battery_values(), _low_range(ctx, p))
    return key, slot, values


def _firmware_value(p: _Power, field: str):
    """The firmware's value of a numeric limit (W, MHz, %) from the boot snapshot, for _merge_low; None unknown."""
    snap = p.run.get("snapshot") or {}
    rapl = [v for v in (snap.get("rapl") or {}).values() if isinstance(v, dict)]
    if field == "pl1_w":
        vals = [v["pl1_uw"] for v in rapl if isinstance(v.get("pl1_uw"), int) and v["pl1_uw"] > 0]
        return _w(min(vals)) if vals else None
    if field == "pl2_w":
        vals = [v["pl2_uw"] for v in rapl if isinstance(v.get("pl2_uw"), int) and v["pl2_uw"] > 0]
        return _w(max(vals)) if vals else None
    if field == "gpu_max_mhz":
        g = snap.get("gpu") if isinstance(snap.get("gpu"), dict) else {}
        if isinstance(g.get("max"), int):
            return g["max"]
        return ((p.hw or {}).get("gpu") or {}).get("rp0")
    if field == "cpu_max_pct":
        perf = snap.get("perf") if isinstance(snap.get("perf"), dict) else {}
        return perf.get("max") if isinstance(perf.get("max"), int) else None
    return None


_LOW_MIN = ("pl1_w", "pl2_w", "gpu_max_mhz", "cpu_max_pct")


def _merge_low(p: _Power, normal: dict, low: dict, rng: dict | None = None) -> dict:
    """The low slot over the profile's own values, never raising a limit: the numeric limits are min(normal, low)
    (a null normal is the firmware's value from the boot snapshot; a null low keeps the normal; an unknown firmware
    value gives the low value); every other field is the low slot's when set, else the normal one. A low EPP over
    a profile's per-core-type EPP replaces them (else the per-type values would hide it). pl2_follow is on when
    either side has it (it only ever lowers boost). Boost: each side's boost is what it gives on battery (the low slot
    runs on battery only): a following side gives sustained × 1.25 of its sustained power clamped to `rng` (the
    battery range, _limits; None: unclamped), so a following low slot lowers an explicit normal boost and an
    explicit low boost never lifts a following normal one."""
    out = dict(normal)
    for f in FIELDS:
        lv, nv = low.get(f), normal.get(f)
        if f == "pl2_follow":
            out[f] = True if (lv is True or nv is True) else (lv if lv is not None else nv)
            continue
        if f == "pl2_w":
            continue                    # below, once sustained power is merged
        if f in _LOW_MIN:
            if lv is None:
                continue
            base = nv if nv is not None else _firmware_value(p, f)
            out[f] = lv if base is None else min(base, lv)
            if nv is None and out[f] == base:
                out[f] = None           # the firmware's own value is already the lower: leave it to the firmware
        elif lv is not None:
            out[f] = lv
    _merge_low_pl2(p, normal, low, out, rng)
    if low.get("epp") is not None and not _epp_split(low):
        out.update({f: None for f in EPP_TYPE_FIELDS})
    if _exclusive_broken(out):
        out.update({f: None for f in CAP_FIELDS})
    return out


def _battery_follow(pl1, rng: dict | None) -> int:
    """The boost pl2_follow gives on battery for a stored sustained power, as _resolve computes it."""
    if rng is None:
        return follow_pl2(pl1, MAX_W, False)
    return follow_pl2(_clamp(pl1, rng["pl1_min"], rng["pl1_max"]), rng["pl2_max"], False)


def _merge_low_pl2(p: _Power, normal: dict, low: dict, out: dict, rng: dict | None) -> None:
    """out["pl2_w"] for _merge_low: min(the normal boost, the low boost), as following (null) when following the
    merged sustained power gives no more than that."""
    nv, lv = normal.get("pl2_w"), low.get("pl2_w")
    if _follows(normal):
        nb = _battery_follow(normal["pl1_w"], rng)
    else:
        nb = nv if nv is not None else _firmware_value(p, "pl2_w")
    if lv is not None:
        lb = lv
    elif low.get("pl2_follow") is True and out.get("pl1_w") is not None:
        lb = _battery_follow(out["pl1_w"], rng)
    else:
        return                          # the low slot leaves boost to the normal values
    target = lb if nb is None else min(nb, lb)
    following = out.get("pl2_follow") is True and out.get("pl1_w") is not None
    if following and _battery_follow(out["pl1_w"], rng) <= target:
        out["pl2_w"] = None             # following the merged sustained power is already the lower
    elif not following and nv is None and target == nb:
        out["pl2_w"] = None             # the firmware's own value is already the lower: leave it to the firmware
    else:
        out["pl2_w"] = target


def _profile_name(p: _Power, key: str) -> str:
    if key == "default":
        return "Default"
    return p.data["profiles"].get(key, {}).get("name") or f"App {key}"


_CPU_KIND = tuple(k for k, v in CONFLICTS.items() if v[1] == "cpu")
# Which active (not ignored) conflicts keep OXP3 Deck from writing a field group: power-profiles-daemon sets EPP
# and boost but not the speed cap or the slider (it cooperates with the slider: its `balanced` uses our value)
FIELD_BLOCKERS = {
    "epp": _CPU_KIND,
    "turbo": _CPU_KIND,
    "cpu_pct": ("intel_lpmd", "tuned"),
    "cpu_caps": ("intel_lpmd", "tuned"),
    "soc": ("intel_lpmd",),
    "gpu_profile": (),
}


def _lpmd_paused(ctx) -> bool:
    """extras.py has intel_lpmd in LPM_FORCE_OFF for the running game (then it blocks nothing). Imported lazily:
    a missing or failing extras module reads as False."""
    try:
        from . import extras
        return extras.lpmd_paused(ctx) is True
    except Exception:
        return False


def _blocking_rows(ctx, p: _Power) -> list[dict]:
    """The active, not ignored "cpu" conflicts (intel_lpmd left out while extras has it paused)."""
    rows = [r for r in _present(p) if r["kind"] == "cpu" and not r["ignored"]]
    if any(r["id"] == "intel_lpmd" for r in rows) and _lpmd_paused(ctx):
        rows = [r for r in rows if r["id"] != "intel_lpmd"]
    return rows


def _blocked_fields(ctx, p: _Power) -> dict:
    """{field group: [conflict ids]} of the groups that are blocked now (only those)."""
    rows = [r["id"] for r in _blocking_rows(ctx, p)]
    out = {}
    for group, ids in FIELD_BLOCKERS.items():
        hit = [r for r in rows if r in ids]
        if hit:
            out[group] = hit
    return out


def _group(item: str) -> str | None:
    """The field group of an `ours` id (None: power limits and GPU clocks, which only "blocks" conflicts stop)."""
    if item == "epp" or item.startswith("epp/"):
        return "epp"
    if item == "turbo":
        return "turbo"
    if item in ("cpu/max_pct", "cpu/min_pct"):
        return "cpu_pct"
    if item.startswith("cpu/cap/"):
        return "cpu_caps"
    if item.startswith("soc/"):
        return "soc"
    if item == "gpu/profile":
        return "gpu_profile"
    return None


def _cpu_rows(ctx, p: _Power) -> list[dict]:
    """The conflicts behind cpu_blocked (EPP and boost)."""
    ids = set((_blocked_fields(ctx, p).get("epp") or []))
    return [r for r in _blocking_rows(ctx, p) if r["id"] in ids]


def _cpu_blocked(ctx, p: _Power) -> str | None:
    rows = _cpu_rows(ctx, p)
    if not rows:
        return None
    names = ", ".join(r["name"] for r in rows)
    return f"{names} {'controls' if len(rows) == 1 else 'control'} energy preference and CPU boost"


def _snap_or(snap: dict, reading: dict | None, key: str):
    """The snapshot's `key`, or (before one is taken) the reading's."""
    if snap and key in snap:
        return snap.get(key)
    return (reading or {}).get(key)


def _first_policies(hw: dict) -> dict:
    """{core type: its first policy}."""
    types = (hw.get("cpu") or {}).get("types") or {}
    return {t: pols[0] for t, pols in types.items() if pols}


def _policy_types(hw: dict) -> dict:
    """{policy: core type}."""
    out = {}
    for t, pols in ((hw.get("cpu") or {}).get("types") or {}).items():
        for pol in pols:
            out[pol] = t
    return out


def _epp_split(values: dict) -> bool:
    return any(values.get(f) is not None for f in EPP_TYPE_FIELDS)


def _resolve(ctx, p: _Power, values: dict, ac, reading: dict | None = None) -> tuple[dict, dict]:
    """(Target for powerhw.apply, the applied values in W/MHz/%): clamped to the range of the moment, nulls filled
    with the boot snapshot (or, before one is taken, with `reading`). A blocked field group is left out."""
    hw = _hw(ctx, p)
    rng = _limits(ctx, p, hw, ac, reading)
    snap = p.run.get("snapshot") or {}
    if (not snap or any(k not in snap for k in _SNAP_NEW)) and reading is None:
        reading = powerhw.read(ctx, hw, gpu=hw.get("gpu") is not None)
    base_rapl = snap.get("rapl") if snap else reading["rapl"]
    blocked = _blocked_fields(ctx, p)
    target: dict = {}
    pl1, pl2 = values.get("pl1_w"), values.get("pl2_w")
    if pl1 is not None:
        pl1 = _clamp(pl1, rng["pl1_min"], rng["pl1_max"])
    if pl2 is not None:
        pl2 = _clamp(pl2, max(pl1 if pl1 is not None else MIN_W, rng["pl1_min"]), rng["pl2_max"])
    follow = pl1 is not None and pl2 is None and values.get("pl2_follow") is True
    if follow:
        pl2 = follow_pl2(pl1, rng["pl2_max"], ac)
    rapl = {}
    for z in hw.get("rapl") or []:
        s = (base_rapl or {}).get(z["id"]) or {}
        z1 = _uw(pl1) if pl1 is not None else s.get("pl1_uw")
        z2 = _uw(pl2) if pl2 is not None else s.get("pl2_uw")
        if pl2 is None and z2 is not None:
            z2 = min(z2, _uw(rng["pl2_max"]))      # a leftover above the ceiling is not "the firmware's"
        if z.get("pl2") is None:
            z2 = None
        if z1 is not None and z2 is not None and z2 < z1:
            z2 = z1
        t = {k: v for k, v in (("pl1_uw", z1), ("pl2_uw", z2)) if v is not None}
        if t:
            rapl[z["id"]] = t
    if rapl:
        target["rapl"] = rapl
    g = hw.get("gpu")
    if g:
        sg = (snap.get("gpu") if snap else (reading or {}).get("gpu")) or {}
        lo, hi = values.get("gpu_min_mhz"), values.get("gpu_max_mhz")
        lo = _clamp(lo, g["rpn"], g["rp0"]) if lo is not None else sg.get("min")
        hi = _clamp(hi, g["rpn"], g["rp0"]) if hi is not None else sg.get("max")
        if lo is not None and hi is not None and lo > hi:
            lo = hi
        tg = {k: v for k, v in (("min", lo), ("max", hi)) if v is not None}
        if tg:
            target["gpu"] = tg
        if g.get("power_profile") and "gpu_profile" not in blocked:
            gp = values.get("gpu_power_profile")
            if gp is None:
                gp = snap["gpu_profile"] if "gpu_profile" in snap else ((reading or {}).get("gpu") or {}).get("profile")
            if gp in powerhw.GPU_PROFILES:
                target["gpu_profile"] = gp
    cpu = hw.get("cpu") or {}
    ptype = _policy_types(hw)
    if "epp" not in blocked and cpu.get("epp"):
        sepp = _snap_or(snap, reading, "epp") or {}
        base = {k: v for k, v in sepp.items() if isinstance(v, str)}
        if _epp_split(values):
            want = {}
            for pol in cpu.get("policies") or []:
                v = values.get(f"epp_{ptype.get(pol, 'p')}") or values.get("epp") or base.get(pol)
                if v is not None:
                    want[pol] = v
            if want:
                target["epp"] = want
        elif values.get("epp") is not None:
            target["epp"] = values["epp"]
        elif base:
            target["epp"] = base
    if "turbo" not in blocked and cpu.get("turbo"):
        sturbo = _snap_or(snap, reading, "turbo")
        t = values.get("turbo") if values.get("turbo") is not None else sturbo
        if isinstance(t, bool):
            target["turbo"] = t
    sperf = _snap_or(snap, reading, "perf") or {}
    if cpu.get("perf_pct") and "cpu_pct" not in blocked and isinstance(sperf.get("max"), int) \
            and isinstance(sperf.get("min"), int):
        mx = values.get("cpu_max_pct") if values.get("cpu_max_pct") is not None else sperf["max"]
        mn = sperf["min"]
        if ac is True and values.get("cpu_min_pct") is not None:      # the floor costs power: AC only
            mn = _clamp(values["cpu_min_pct"], sperf["min"], max(sperf["min"], min(CPU_MIN_PCT_MAX, mx)))
        target["perf"] = {"max": mx, "min": min(mn, mx)}
    scaps = _snap_or(snap, reading, "caps") or {}
    if ptype and "cpu_caps" not in blocked:
        caps = {}
        for pol, t in ptype.items():
            v = values.get(f"cpu_cap_{t}_mhz")
            v = v * 1000 if v is not None else scaps.get(pol)
            if isinstance(v, int):
                caps[pol] = v
        if caps:
            target["caps"] = caps
    ssoc = _snap_or(snap, reading, "soc") or {}
    if hw.get("soc") and "soc" not in blocked:
        sb = values.get("soc_balance") if values.get("soc_balance") is not None else ssoc.get("balance")
        so = values.get("soc_offset") if values.get("soc_offset") is not None else ssoc.get("offset")
        ts = {k: v for k, v in (("balance", sb), ("offset", so)) if isinstance(v, int)}
        if ts:
            target["soc"] = ts
    pol0 = (cpu.get("policies") or [None])[0]
    rt = (target.get("rapl") or {}).values()
    t1 = [t["pl1_uw"] for t in rt if "pl1_uw" in t]
    t2 = [t["pl2_uw"] for t in rt if "pl2_uw" in t]
    epp = target.get("epp")
    firsts = _first_policies(hw)
    perf = target.get("perf") or {}
    caps = target.get("caps") or {}
    soc = target.get("soc") or {}
    applied = {
        "pl1_w": _w(min(t1)) if t1 else None, "pl2_w": _w(min(t2)) if t2 else None,
        "gpu_min_mhz": (target.get("gpu") or {}).get("min"), "gpu_max_mhz": (target.get("gpu") or {}).get("max"),
        "epp": epp if isinstance(epp, str) else epp.get(pol0) if isinstance(epp, dict) else None,
        "turbo": target.get("turbo"),
        "cpu_max_pct": perf.get("max"), "cpu_min_pct": perf.get("min"),
        "soc_balance": soc.get("balance"), "soc_offset": soc.get("offset"),
        "gpu_power_profile": target.get("gpu_profile"),
        "fan_mode": values.get("fan_mode"), "scx_mode": values.get("scx_mode"),
        "pl2_follow": True if follow and t2 else None,
    }
    for t in CORE_TYPES:
        pol = firsts.get(t)
        cap = caps.get(pol) if pol else None
        applied[f"cpu_cap_{t}_mhz"] = cap // 1000 if isinstance(cap, int) else None
        applied[f"epp_{t}"] = (epp if isinstance(epp, str) else epp.get(pol) if isinstance(epp, dict) else None) \
            if pol else None
    return target, applied


_SNAP_NEW = ("perf", "caps", "soc", "gpu_profile")   # added in 0.4: filled into a 0.3 snapshot of this boot


def _snap_new(r: dict) -> dict:
    soc = r.get("soc")
    caps = r.get("caps")
    return {"perf": dict(r["perf"]) if r.get("perf") else None,
            "caps": {k: v for k, v in caps.items() if isinstance(v, int)} if caps else None,
            "soc": {"balance": soc["balance"], "offset": soc["offset"]} if soc else None,
            "gpu_profile": (r.get("gpu") or {}).get("profile")}


# The snapshot groups another program may already have rewritten (intel_lpmd's Panther Lake config sets
# MinPerfPctAC 50 and its own slider values; tuned sets the cap): while one of them is present at snapshot time,
# ignored or paused or not, its values are its leftovers, and stay until reboot even after it stops.
_SNAP_TAINT = {"perf": FIELD_BLOCKERS["cpu_pct"], "soc": FIELD_BLOCKERS["soc"]}


def _driver_floor(ctx, hw: dict) -> int | None:
    """intel_pstate's own min_perf_pct while nobody has changed it: min_pstate * 100 // turbo_pstate of CPU 0 (as
    min_perf_pct_min()), from policy0's cpuinfo frequencies, plus 1 so a rounding difference stays inside the
    driver's range."""
    pol = ((hw.get("cpu") or {}).get("policies") or ["policy0"])[0]
    lo = powerhw._int(powerhw._read(powerhw._policy_file(ctx, pol, "cpuinfo_min_freq")))
    hi = powerhw._int(powerhw._read(powerhw._policy_file(ctx, pol, "cpuinfo_max_freq")))
    if not lo or not hi or lo >= hi:
        return None
    return min(CPU_MIN_PCT_MAX, lo * 100 // hi + 1)


def _snap_untaint(ctx, p: _Power, hw: dict, new: dict) -> None:
    """Replace the tainted groups of a new snapshot with the drivers' defaults (cap 100, the driver's floor,
    slider 3 offset 0)."""
    present = {r["id"] for r in _rows(ctx, p) if r["kind"] == "cpu"}
    for key, ids in _SNAP_TAINT.items():
        hit = sorted(present & set(ids))
        if not hit or not new.get(key):
            continue
        if key == "perf":
            fl = _driver_floor(ctx, hw)
            cur = new["perf"].get("min")
            new["perf"] = {"max": 100, "min": min(fl, cur) if isinstance(cur, int) and fl else fl or cur}
        else:
            new["soc"] = {"balance": 3, "offset": 0}
        log.info("power: boot snapshot: %s present, %s taken as the driver defaults %s", ", ".join(hit), key,
                 new[key])


def _ensure_snapshot(ctx, p: _Power) -> None:
    snap = p.run.get("snapshot")
    if snap:
        missing = [k for k in _SNAP_NEW if k not in snap]
        if missing:      # a plugin upgraded in the middle of a boot: fill the missing keys only, never retake
            hw = _hw(ctx, p)
            new = _snap_new(powerhw.read(ctx, hw, gpu=False))
            _snap_untaint(ctx, p, hw, new)
            snap.update({k: new[k] for k in missing})
            log.info("power: boot snapshot filled in: %s", {k: new[k] for k in missing})
            _save_run(ctx, p)
        return
    hw = _hw(ctx, p)
    r = powerhw.read(ctx, hw, gpu=hw.get("gpu") is not None)
    # Taken when TDP control first writes this boot, so a zone can hold another tool's leftover (SimpleDeckyTDP
    # writes PL1 = PL2 to MMIO only). Firmware sets the same PL2 on both interfaces: when they disagree, the highest
    # is the firmware's.
    pl2s = [v.get("pl2_uw") for v in r["rapl"].values() if isinstance(v.get("pl2_uw"), int) and v["pl2_uw"] > 0]
    top = max(pl2s) if pl2s else None
    new = _snap_new(r)
    _snap_untaint(ctx, p, hw, new)
    p.run["snapshot"] = {
        "taken_at": time.time(),
        "rapl": {zid: {"pl1_uw": v.get("pl1_uw"), "pl2_uw": top if isinstance(v.get("pl2_uw"), int) and
                       v["pl2_uw"] > 0 and top is not None else v.get("pl2_uw")}
                 for zid, v in r["rapl"].items()},
        "gpu": {"min": r["gpu"]["min"], "max": r["gpu"]["max"]} if r.get("gpu") else None,
        "epp": dict(r["epp"]) if r.get("epp") else None,
        "turbo": r.get("turbo"),
        **new,
    }
    log.info("power: boot snapshot taken: %s", p.run["snapshot"])
    _save_run(ctx, p)


def _ours(hw: dict, target: dict, res: dict, locked: list, split: bool = False) -> dict:
    """What the apply left in place (written, or already equal), as read back."""
    failed = {f["id"] for f in res["failed"]}
    reading = res["reading"]
    ours = {}
    for zid, t in (target.get("rapl") or {}).items():
        for k in ("pl1", "pl2"):
            item = f"{zid}/{k}"
            got = reading["rapl"].get(zid, {}).get(f"{k}_uw")
            if f"{k}_uw" in t and item not in failed and item not in locked and got is not None:
                ours[item] = got
    for k in ("min", "max"):
        got = (reading.get("gpu") or {}).get(k)
        if k in (target.get("gpu") or {}) and f"gpu/{k}" not in failed and "gpu" not in failed and got is not None:
            ours[f"gpu/{k}"] = got
    pol0 = ((hw.get("cpu") or {}).get("policies") or [None])[0]
    if "epp" in target and not any(f == "epp" or f.startswith("epp/") for f in failed):
        if split:
            for pol in _first_policies(hw).values():
                got = (reading.get("epp") or {}).get(pol)
                if got is not None:
                    ours[f"epp/{pol}"] = got
        else:
            got = (reading.get("epp") or {}).get(pol0)
            if got is not None:
                ours["epp"] = got
    if "turbo" in target and "turbo" not in failed and reading.get("turbo") is not None:
        ours["turbo"] = reading["turbo"]
    perf = reading.get("perf") or {}
    for k in ("max", "min"):
        item = f"cpu/{k}_pct"
        want = (target.get("perf") or {}).get(k)
        if want is not None and item not in failed and perf.get(k) == want:
            ours[item] = perf[k]
    caps = reading.get("caps") or {}
    for pol in _first_policies(hw).values():
        item = f"cpu/cap/{pol}"
        if pol in (target.get("caps") or {}) and item not in failed and caps.get(pol) is not None:
            ours[item] = caps[pol]
    soc = reading.get("soc") or {}
    for k in ("balance", "offset"):      # only when it reads what was asked (slider_balance reads its old value
        item = f"soc/{k}"                # until a profile write)
        want = (target.get("soc") or {}).get(k)
        if want is not None and item not in failed and soc.get(k) == want:
            ours[item] = want
    gp = target.get("gpu_profile")
    if gp is not None and "gpu/profile" not in failed and (reading.get("gpu") or {}).get("profile") == gp:
        ours["gpu/profile"] = gp
    return ours


def _do_apply(ctx, p: _Power, target: dict, split: bool = False, retry: bool = False) -> dict:
    hw = _hw(ctx, p)
    res = powerhw.apply(ctx, hw, target, p.run["locked"])
    newly = [f["id"] for f in res["failed"] if f.get("locked")]
    if newly:
        log.warning("power: locked by firmware this boot: %s", ", ".join(newly))
    p.run["locked"] = sorted(set(p.run["locked"]) | set(newly))
    p.run["ours"] = _ours(hw, target, res, p.run["locked"], split)
    for g in [g for g in p.yielded if any(_group(k) == g for k in p.run["ours"])]:
        del p.yielded[g]        # written again (a change, an event): ours until the other program changes it again
    p.last = {"ok": res["ok"], "error": res["error"], "written": res["written"], "failed": res["failed"]}
    p.started = True
    p.unsettled_at = _monotonic()
    p.drift_seen = None
    p.pending = [f["id"] for f in res["failed"] if f.get("transient")]
    if not retry:
        p.pending_left = PENDING_RETRIES
    if res["written"] or res["failed"]:
        log.info("power: wrote %s%s", ", ".join(res["written"]) or "nothing",
                 f"; failed: {res['error']}" if res["failed"] else "")
    _save_run(ctx, p)
    return p.last


def _apply(ctx, p: _Power, retry: bool = False) -> dict:
    """Resolve the active profile and write it."""
    _hw(ctx, p)
    _ensure_snapshot(ctx, p)
    ac = powerhw.ac_online(ctx)
    _key, _slot, values = _active(p, ac, ctx)
    target, _applied = _resolve(ctx, p, values, ac)
    return _do_apply(ctx, p, target, split=_epp_split(values) and "epp" in target, retry=retry)


def _restore(ctx, p: _Power) -> dict | None:
    """Write the boot snapshot back ("TDP control" off); a blocked field group is left to its program."""
    snap = p.run.get("snapshot")
    if not snap:
        return None
    hw = _hw(ctx, p)
    blocked = _blocked_fields(ctx, p)
    target: dict = {}
    rapl = {zid: {k: v for k, v in vals.items() if k in ("pl1_uw", "pl2_uw") and isinstance(v, int)}
            for zid, vals in (snap.get("rapl") or {}).items() if isinstance(vals, dict)}
    rapl = {k: v for k, v in rapl.items() if v}
    if rapl:
        target["rapl"] = rapl
    if hw.get("gpu") and isinstance(snap.get("gpu"), dict):
        tg = {k: v for k, v in snap["gpu"].items() if k in ("min", "max") and isinstance(v, int)}
        if tg:
            target["gpu"] = tg
    if "epp" not in blocked and isinstance(snap.get("epp"), dict):
        e = {k: v for k, v in snap["epp"].items() if isinstance(v, str)}
        if e:
            target["epp"] = e
    if "turbo" not in blocked and isinstance(snap.get("turbo"), bool):
        target["turbo"] = snap["turbo"]
    cpu = hw.get("cpu") or {}
    perf = snap.get("perf")
    if cpu.get("perf_pct") and "cpu_pct" not in blocked and isinstance(perf, dict) \
            and isinstance(perf.get("max"), int) and isinstance(perf.get("min"), int):
        target["perf"] = {"max": perf["max"], "min": perf["min"]}
    caps = snap.get("caps")
    if "cpu_caps" not in blocked and isinstance(caps, dict):
        tc = {k: v for k, v in caps.items() if k in (cpu.get("policies") or []) and isinstance(v, int)}
        if tc:
            target["caps"] = tc
    soc = snap.get("soc")
    if hw.get("soc") and "soc" not in blocked and isinstance(soc, dict):
        ts = {k: soc[k] for k in ("balance", "offset") if isinstance(soc.get(k), int)}
        if ts:
            target["soc"] = ts
    if (hw.get("gpu") or {}).get("power_profile") and snap.get("gpu_profile") in powerhw.GPU_PROFILES:
        target["gpu_profile"] = snap["gpu_profile"]
    res = _do_apply(ctx, p, target)
    p.run["ours"] = {}
    p.pending = []
    _save_run(ctx, p)
    return res


def _whole_failure(p: _Power, applied: dict | None) -> bool:
    # pl4 is a warning; a transient failure (the GPU asleep) is retried by tick, not an error
    real = [f for f in (applied or {}).get("failed") or [] if not f["id"].endswith("/pl4") and not f.get("transient")]
    return bool(applied and real and not applied["written"])


# ---- conflicts ---------------------------------------------------------------------------------------------------

def _homebrew(ctx) -> str:
    return os.path.dirname(os.path.dirname(ctx.settings_dir.rstrip("/")))


def _systemctl() -> str:
    return sysexec.which("systemctl") or "/usr/bin/systemctl"


def _last_line(r, fallback: str) -> str:
    lines = (r.err or r.out or "").strip().splitlines()
    return lines[-1].strip() if lines else fallback


def _units(ctx) -> tuple[dict | None, str | None]:
    """({unit: (LOAD, active)} of every service systemd lists, or None, and why not)."""
    r = sysexec.run([_systemctl(), "list-units", "--all", "--type=service", "--plain", "--no-legend", "--no-pager"],
                    timeout=10)
    if r.rc != 0:
        return None, _last_line(r, f"exit {r.rc}")
    units = {}
    for line in r.out.splitlines():
        parts = line.split()
        if parts and parts[0] in ("●", "*", "○"):
            parts = parts[1:]
        if len(parts) >= 3:
            units[parts[0]] = (parts[1], parts[2] in _ACTIVE)
    return units, None


def _comms(ctx) -> set:
    base = ctx.sys_path("/proc")
    found = set()
    try:
        with os.scandir(base) as it:
            pids = [e.name for e in it if e.name.isdigit()]
    except OSError:
        return found
    wanted = set(_COMMS.values())
    for pid in pids:
        c = _text(os.path.join(base, pid, "comm"), 64)
        if c in wanted:
            found.add(c)
    return found


def _plugins(ctx) -> dict:
    """{plugin name: enabled} of Decky's other plugins that are known to set power limits."""
    brew = _homebrew(ctx)
    disabled: list = []
    raw = context.read_small(os.path.join(brew, "settings", "loader.json"), 1_000_000)
    if raw is not None:
        try:
            got = json.loads(raw.decode("utf-8"))
            if isinstance(got, dict) and isinstance(got.get("disabled_plugins"), list):
                disabled = [d for d in got["disabled_plugins"] if isinstance(d, str)]
        except ValueError:
            pass
    out = {}
    try:
        with os.scandir(os.path.join(brew, "plugins")) as it:
            folders = [e.name for e in it]
    except OSError:
        folders = []
    for folder in folders:
        raw = context.read_small(os.path.join(brew, "plugins", folder, "plugin.json"), 65536)
        if raw is None:
            continue
        try:
            name = json.loads(raw.decode("utf-8")).get("name")
        except (ValueError, AttributeError):
            continue
        if isinstance(name, str) and name in _PLUGINS:
            out[name] = name not in disabled
    return out


def _steamos_remote(ctx) -> str | None:
    for folder in REMOTES:
        base = ctx.sys_path(folder)
        try:
            with os.scandir(base) as it:
                names = sorted(e.name for e in it)
        except OSError:
            continue
        for name in names:
            raw = context.read_small(os.path.join(base, name), 1_000_000)
            if raw is not None and b"TdpLimit1" in raw:
                return os.path.join(folder, name)
    return None


def _row(cid: str, name: str | None = None, why: str | None = None, fix: str | None = None,
         loaded: dict | None = None, active: set | None = None) -> dict:
    n, kind, ignorable, w, f = CONFLICTS[cid]
    name = name or n
    fix_units = [u for u in FIXABLE.get(cid, ()) if (loaded or {}).get(u) == "loaded"]
    return {"id": cid, "name": name, "kind": kind, "ignorable": ignorable, "why": why or w,
            "fix": (fix or f).replace("{name}", name), "fix_units": fix_units,
            "fix_plan": _fix_plan(fix_units, active or set()) if fix_units else None}


def _fix_plan(units: list[str], active: set) -> dict | None:
    """{disable, stop, mask}: what fix() would run now (it disables only enabled units, stops only running ones,
    masks the MASKABLE ones), for the confirm dialog; None when systemctl show cannot tell."""
    disable = []
    for u in units:
        got, _err = _show(u)
        if got is None or "UnitFileState" not in got:
            return None
        if got["UnitFileState"] == "enabled":
            disable.append(u)
    return {"disable": disable, "stop": [u for u in units if u in active], "mask": [u for u in units if u in MASKABLE]}


def _scan(ctx, p: _Power) -> list[dict]:
    rows: list[dict] = []
    units, err = _units(ctx)
    p.loaded = {u: v[0] for u, v in units.items()} if units is not None else {}
    active = {u for u, v in units.items() if v[1]} if units is not None else None
    comms = _comms(ctx)
    seen = set()
    for name, enabled in sorted(_plugins(ctx).items()):
        cid = _PLUGINS[name]
        if enabled and cid not in seen:
            seen.add(cid)
            rows.append(_row(cid, name))
    for cid in CONFLICTS:
        if cid in seen:
            continue
        hit = False
        if active is not None and cid in _UNITS and any(_UNITS[cid].match(u) for u in active):
            hit = True
        if cid in _COMMS and _COMMS[cid] in comms:
            hit = True
        if hit:
            seen.add(cid)
            rows.append(_row(cid, loaded=p.loaded, active=active))
    remote = _steamos_remote(ctx)
    if remote:
        rows.append(_row("steamos-remote", why=f"{remote} lets Steam's TDP slider write the power limits"))
    if active is None:
        rows.append({"id": "unknown", "name": "Unknown", "kind": "suspect", "ignorable": False,
                     "why": f"could not list services: {err}", "fix": "check that systemd is running",
                     "fix_units": [], "fix_plan": None})
    order = list(CONFLICTS) + ["unknown"]
    rows.sort(key=lambda r: order.index(r["id"]))
    return rows


def _rows(ctx, p: _Power, force: bool = False) -> list[dict]:
    now = _monotonic()
    if force or p.rows is None or p.rows_at is None or now - p.rows_at >= CONFLICT_RECHECK_S:
        p.rows = _scan(ctx, p)
        p.rows_at = now
    return _present(p)


def _present(p: _Power) -> list[dict]:
    ignore = set(p.data["ignore"])
    return [dict(r, fix_units=list(r["fix_units"]), fix_plan=copy.deepcopy(r.get("fix_plan")),
                 ignored=r["ignorable"] and r["id"] in ignore,
                 fixed=_fixed_one(p, r["id"], came_back=True) if r["id"] in p.data["fixed"] else None)
            for r in (p.rows or [])]


def _fixed_one(p: _Power, cid: str, came_back: bool) -> dict:
    rec = p.data["fixed"][cid]
    return {"id": cid, "name": CONFLICTS[cid][0], "at": rec["at"], "units": copy.deepcopy(rec["units"]),
            "came_back": came_back}


def _fixed_all(p: _Power) -> list[dict]:
    """PowerFixed[] of every record (also of conflicts that are gone: their Undo)."""
    running = {r["id"] for r in (p.rows or [])}
    return [_fixed_one(p, cid, cid in running) for cid in FIXABLE if cid in p.data["fixed"]]


def _blockers(p: _Power) -> list[dict]:
    return [r for r in _present(p) if r["kind"] == "blocks" and not r["ignored"]]


def _blocked_text(rows: list[dict]) -> str:
    return "another power manager is active: " + ", ".join(r["name"] for r in rows)


def _update_blocked(ctx, p: _Power) -> bool:
    """Set or clear p.blocked from the last check (while enabled). True when it was just cleared."""
    if not p.data["enabled"]:
        p.blocked = None
        return False
    b = _blockers(p)
    if b:
        if p.blocked is None:
            log.warning("power: %s; nothing is written until it is gone", _blocked_text(b))
        p.blocked = _blocked_text(b)
        return False
    cleared = p.blocked is not None
    p.blocked = None
    return cleared


# ---- drift -------------------------------------------------------------------------------------------------------

def _fmt(item: str, v) -> str:
    if v is None:
        return "unreadable"
    if item.startswith("cpu/cap/"):
        return f"{v // 1000} MHz" if isinstance(v, int) else str(v)
    if item in ("cpu/max_pct", "cpu/min_pct"):
        return f"{v} %"
    if item == "gpu/profile" or item.startswith("soc/") or item == "epp" or item.startswith("epp/"):
        return str(v)
    if item.startswith("gpu/"):
        return f"{v} MHz"
    if item == "turbo":
        return "on" if v else "off"
    return f"{_w(v):g} W"


def _drift(p: _Power, reading: dict, gpu_only: bool) -> tuple | None:
    """(id, ours, now) of the first value that differs from what the last apply left, else None. gpu_only: the GPU
    clocks only (they wake the GPU, so only state() reads them)."""
    hw = p.hw or {}
    pol0 = ((hw.get("cpu") or {}).get("policies") or [None])[0]
    for item, want in sorted(p.run["ours"].items()):
        if item in ("gpu/min", "gpu/max"):
            got = (reading.get("gpu") or {}).get(item[4:])
            differs = got is not None and abs(got - want) > powerhw.GPU_TOLERANCE_MHZ
        elif gpu_only:
            continue
        elif item == "gpu/profile":
            got = (reading.get("gpu") or {}).get("profile")
            differs = got is not None and got != want
        elif item == "epp" or item.startswith("epp/"):
            got = (reading.get("epp") or {}).get(pol0 if item == "epp" else item[4:])
            differs = got is not None and got != want
        elif item == "turbo":
            got = reading.get("turbo")
            differs = got is not None and got != want
        elif item in ("cpu/max_pct", "cpu/min_pct"):
            got = (reading.get("perf") or {}).get(item[4:7])
            differs = got is not None and got != want
        elif item.startswith("cpu/cap/"):
            got = (reading.get("caps") or {}).get(item[len("cpu/cap/"):])
            differs = got is not None and isinstance(want, int) and abs(got - want) > powerhw.CAP_TOLERANCE_KHZ
        elif item.startswith("soc/"):
            # the slider's values, not the platform profile: power-profiles-daemon switching the profile is its
            # own business, not drift
            got = (reading.get("soc") or {}).get(item[4:])
            differs = got is not None and got != want
        else:
            zid, _, k = item.rpartition("/")
            got = (reading.get("rapl") or {}).get(zid, {}).get(f"{k}_uw")
            differs = got is not None and abs(got - want) > powerhw.RAPL_TOLERANCE_UW
        if differs:
            return item, want, got
    return None


def _suspects(p: _Power, item: str) -> list[str]:
    """Conflict ids that can change `item` (ignored ones too: one may have been ignored by mistake): EPP and turbo
    the "cpu" kind; the CPU speed controls and the slider the "cpu" kind and Handheld Daemon; power limits and GPU
    settings the "blocks" kind. None found: Steam's own controls for power limits and GPU clocks, else "other"."""
    rows = _present(p)
    group = _group(item)
    if group in ("epp", "turbo"):
        found = [r["id"] for r in rows if r["kind"] == "cpu"]
    elif group in ("cpu_pct", "cpu_caps", "soc"):
        found = [r["id"] for r in rows if r["kind"] == "cpu" or r["id"] == "hhd"]
    else:
        found = [r["id"] for r in rows if r["kind"] == "blocks"]
    if found:
        return found
    return ["other"] if group is not None else ["steam"]


def _ignored_owners(p: _Power, group: str | None) -> list[str]:
    """The ignored CPU conflicts running now that set field group `group` (FIELD_BLOCKERS): [] for power limits and
    GPU clocks, and for a group no ignored one writes."""
    if group is None:
        return []
    ids = FIELD_BLOCKERS.get(group, ())
    return [r["id"] for r in _present(p) if r["kind"] == "cpu" and r["ignored"] and r["id"] in ids]


def _on_drift(ctx, p: _Power, d: tuple, now: float, confirm: bool) -> str:
    item, want, got = d
    p.unsettled_at = now          # N-7: the drift check runs at poll_s again for CALM_S
    # look for other power managers now (the cached check can be a minute old): one that has just started is
    # "blocked" (writes stop, and resume by themselves once it is gone), not an override
    _rows(ctx, p, force=True)
    _update_blocked(ctx, p)
    if p.blocked:
        p.drift_seen = None
        return "blocked"
    group = _group(item)
    blocked = _blocked_fields(ctx, p)
    if group is not None and group in blocked:
        # left to the CPU daemon that has just started: every field group it blocks is no longer ours
        p.run["ours"] = {k: v for k, v in p.run["ours"].items() if _group(k) not in blocked}
        p.drift_seen = None
        _save_run(ctx, p)
        return "nothing"
    if p.grace_until is not None and now < p.grace_until and p.grace_left > 0:
        p.grace_left -= 1
        log.info("power: %s changed to %s after an AC change or resume: applying again", item, _fmt(item, got))
        _apply(ctx, p)
        return "applied"
    if confirm and p.drift_seen != item:
        p.drift_seen = item      # seen once: an AC change the next tick explains is not a fight
        return "nothing"
    owners = _ignored_owners(p, group)
    if owners:
        # an ignored CPU daemon (power-profiles-daemon rewrites EPP on a profile or charger change) changed a field
        # it owns: leave that field group to it instead of stopping every write, power limits included
        p.run["ours"] = {k: v for k, v in p.run["ours"].items() if _group(k) != group}
        p.yielded[group] = owners
        p.drift_seen = None
        log.info("power: %s changed to %s by %s (ignored); leaving %s to it until the next change",
                 item, _fmt(item, got), ", ".join(owners), group)
        _save_run(ctx, p)
        return "nothing"
    suspects = _suspects(p, item)
    p.run["overridden"] = {"what": item, "ours": _fmt(item, want), "now": _fmt(item, got), "since": time.time(),
                           "suspects": suspects}
    p.drift_seen = None
    log.warning("power: something else changed %s (now %s, OXP3 Deck set %s); not writing until the user acts",
                item, _fmt(item, got), _fmt(item, want))
    _save_run(ctx, p)
    return "overridden"


# ---- answers -----------------------------------------------------------------------------------------------------

def _epp_summary(epp: dict | None):
    if not epp:
        return None
    vals = {v for v in epp.values() if v is not None}
    if not vals:
        return None
    return vals.pop() if len(vals) == 1 else "mixed"


def _state(ctx, p: _Power, reading: dict | None = None) -> dict:
    hw = _hw(ctx, p)
    if reading is None:
        reading = powerhw.read(ctx, hw, gpu=hw.get("gpu") is not None)
    ac = reading.get("ac")
    key, slot, values = _active(p, ac, ctx)
    _target, applied = _resolve(ctx, p, values, ac, reading)
    snap = p.run.get("snapshot") or {}
    locked = set(p.run["locked"])
    zones = []
    for z in hw.get("rapl") or []:
        r = reading["rapl"].get(z["id"], {})
        b = (snap.get("rapl") or {}).get(z["id"]) or {}
        zones.append({"id": z["id"], "iface": z["iface"], "name": z["name"], "pl1_w": _w(r.get("pl1_uw")),
                      "pl2_w": _w(r.get("pl2_uw")), "pl4_w": _w(r.get("pl4_uw")), "boot_pl1_w": _w(b.get("pl1_uw")),
                      "boot_pl2_w": _w(b.get("pl2_uw")), "pl1_base_w": _w((z.get("pl1") or {}).get("max_uw")),
                      "locked": [k for k in ("pl1", "pl2") if f"{z['id']}/{k}" in locked]})
    pl1s = [z["pl1_w"] for z in zones if z["pl1_w"] is not None]
    pl2s = [z["pl2_w"] for z in zones if z["pl2_w"] is not None]
    g = reading.get("gpu")
    firsts = _first_policies(hw)
    perf = reading.get("perf") or {}
    caps = reading.get("caps") or {}
    epp_now = reading.get("epp")
    return {
        "enabled": p.data["enabled"],
        "active": {"key": key, "name": _profile_name(p, key), "slot": slot, "app": p.run.get("app"), "ac": ac},
        "values": dict(values),
        "applied_values": applied,
        "now": {"pl1_w": min(pl1s) if pl1s else None, "pl2_w": min(pl2s) if pl2s else None, "zones": zones,
                "gpu": {"min": g["min"], "max": g["max"], "act": g["act"], "reasons": g["reasons"]} if g else None,
                "epp": _epp_summary(reading.get("epp")), "turbo": reading.get("turbo"),
                "governor": reading.get("governor"),
                "cpu_max_pct": perf.get("max"), "cpu_min_pct": perf.get("min"),
                "caps_mhz": {t: caps[pol] // 1000 if isinstance(caps.get(pol), int) else None
                             for t, pol in firsts.items()},
                "soc": dict(reading["soc"]) if reading.get("soc") else None,
                "gpu_profile": g.get("profile") if g else None,
                "epp_types": {t: (epp_now or {}).get(pol) if epp_now is not None else None
                              for t, pol in firsts.items()}},
        "range": _limits(ctx, p, hw, ac, reading),
        "overridden": p.run.get("overridden"),
        "blocked": p.blocked,
        "blocked_fields": _blocked_fields(ctx, p),
        "cpu_blocked": _cpu_blocked(ctx, p),
        "cpu_blocked_by": [r["id"] for r in _cpu_rows(ctx, p)],
        "yielded": sorted(p.yielded),
        "last": p.last,
        "low": _low_state(p, key),
    }


def _low_state(p: _Power, key: str) -> dict | None:
    """PowerLow (None while low_battery is off)."""
    if not p.data["low_battery"]:
        return None
    low = p.run.get("low")
    thr = p.data["low_battery_pct"]
    held = bool(low) and _low_held(p, key)
    pct = p.low_pct if p.low_pct is not None else (low or {}).get("pct")
    return {"active": bool(low) and not held, "held": held, "pct": pct, "enter_pct": thr,
            "leave_pct": thr + LOW_HYST_PCT, "since": low["since"] if low else None}


def _safe_state(ctx, p: _Power):
    try:
        return _state(ctx, p)
    except Exception:
        log.exception("power: state failed")
        return None


def _refuse(ctx, p: _Power | None, error: str, **extra) -> dict:
    return {"ok": False, "error": error, "state": _safe_state(ctx, p) if p is not None else None, "applied": None,
            **extra}


def _changed(ctx, p: _Power, applied: dict | None) -> dict:
    whole = _whole_failure(p, applied)
    return {"ok": not whole, "error": applied["error"] if whole else None, "state": _safe_state(ctx, p),
            "applied": applied}


def _first_check(ctx, p: _Power) -> None:
    """A new process has not looked for other power managers yet (the first tick does): look now, before a write."""
    if p.data["enabled"] and p.rows is None:
        _rows(ctx, p, force=True)
        _update_blocked(ctx, p)


def _may_write(ctx, p: _Power) -> bool:
    _first_check(ctx, p)
    return p.data["enabled"] and p.blocked is None and p.run.get("overridden") is None


# ---- public ------------------------------------------------------------------------------------------------------

_NEW_OPTIONS = ("low_battery", "low_battery_pct", "low_battery_games", "advisor")


def limits(ctx, hw: dict, ac) -> dict:
    """PowerRange (W, MHz) for `hw` and the AC state `ac`."""
    with _LOCK:
        return _limits(ctx, _get(ctx), hw, ac)


def conflicts(ctx) -> list[dict]:
    """PowerConflict[] of the power managers that are active now (systemctl at most every CONFLICT_RECHECK_S)."""
    with _LOCK:
        return _rows(ctx, _get(ctx))


def info(ctx, refresh: bool) -> dict:
    with _LOCK:
        p = _get(ctx)
        if refresh is True:
            p.hw = None
        hw = _hw(ctx, p)
        rows = _rows(ctx, p, force=refresh is True)
        if _update_blocked(ctx, p) and p.data["enabled"]:
            p.apply_at = _monotonic()
        cpu = hw.get("cpu")
        snap = p.run.get("snapshot")
        sdtdp = os.path.join(_homebrew(ctx), "settings", "SimpleDeckyTDP", "settings.json")
        return {"ok": True, "error": None, "info": {
            "hw": {"rapl": any(z["iface"] == "msr" for z in hw["rapl"]),
                   "mmio": any(z["iface"] == "mmio" for z in hw["rapl"]),
                   "gpu": dict({k: hw["gpu"][k] for k in ("card", "gt", "media_gt")},
                               power_profile=bool(hw["gpu"].get("power_profile"))) if hw.get("gpu") else None,
                   "cpu": {"pstate": cpu["pstate"], "epp_choices": list(cpu["epp_choices"]), "turbo": cpu["turbo"],
                           "perf_pct": bool(cpu.get("perf_pct")),
                           "types": [t for t in CORE_TYPES if t in (cpu.get("types") or {})]}
                   if cpu else None,
                   "soc": hw.get("soc") is not None,
                   "ac_supply": hw.get("ac_supply"), "problems": list(hw.get("problems") or []),
                   "time_windows": powerhw.time_windows(ctx, hw)},
            "options": {k: copy.deepcopy(p.data[k]) for k in ("per_game", "split_ac", "extended", "ignore",
                                                              "poll_s", *_NEW_OPTIONS)},
            "profiles": copy.deepcopy(p.data["profiles"]),
            "conflicts": rows,
            "fixed": _fixed_all(p),
            "boot": {"taken_at": snap.get("taken_at")} if snap else None,
            "sdtdp_found": os.path.isfile(sdtdp),
            "state": _state(ctx, p),
            "selftest": _selftest_info(ctx),
        }}


def _selftest_info(ctx):
    """selftest.info(ctx) (stored results, no hardware read), imported lazily; any failure gives None."""
    try:
        from . import selftest
        return selftest.info(ctx)
    except Exception:
        log.exception("power: selftest.info failed")
        return None


def state(ctx) -> dict:
    """PowerStateRes. Reads the GPU clocks (only called while a panel shows), and so checks them for drift."""
    with _LOCK:
        p = _get(ctx)
        p.panel_at = _monotonic()
        hw = _hw(ctx, p)
        reading = powerhw.read(ctx, hw, gpu=hw.get("gpu") is not None)
        if _may_write(ctx, p) and p.apply_at is None:
            d = _drift(p, reading, gpu_only=True)
            if d:
                _on_drift(ctx, p, d, _monotonic(), confirm=False)
                reading = None
        return {"ok": True, "error": None, "state": _state(ctx, p, reading)}


def enable(ctx, on) -> dict:
    with _LOCK:
        p = _get(ctx)
        if not isinstance(on, bool):
            return _refuse(ctx, p, f"power_enable: on must be true or false, not {on!r}")
        _hw(ctx, p)
        if on:
            _rows(ctx, p, force=True)
            blockers = _blockers(p)
            if blockers:
                return _refuse(ctx, p, _blocked_text(blockers), conflicts=blockers)
            p.data["enabled"] = True
            err = _save(p)
            if err:
                p.data["enabled"] = False
                return _refuse(ctx, p, err)
            p.blocked = None
            p.run["overridden"] = None
            return _changed(ctx, p, _apply(ctx, p))
        _first_check(ctx, p)       # do not restore over another power manager that is in charge
        was = p.data["enabled"]
        p.data["enabled"] = False
        err = _save(p)
        if err:
            p.data["enabled"] = was
            return _refuse(ctx, p, err)
        applied = None
        if was and p.blocked is None:
            applied = _restore(ctx, p)
        p.blocked = None
        p.run["overridden"] = None
        p.run["ours"] = {}
        p.run["low"] = None
        p.apply_at = None
        _save_run(ctx, p)
        return _changed(ctx, p, applied)


def options(ctx, opts) -> dict:
    with _LOCK:
        p = _get(ctx)
        if not isinstance(opts, dict):
            return _refuse(ctx, p, "power_options: opts must be an object")
        new = {}
        for k, v in opts.items():
            if k == "poll_s":
                if not _poll_ok(v):
                    return _refuse(ctx, p, f"power_options: poll_s must be 0 (Off) or 2..{POLL_MAX_S} seconds")
                new[k] = v
            elif k == "low_battery_pct":
                if not _low_pct_ok(v):
                    return _refuse(ctx, p, f"power_options: low_battery_pct must be a whole number "
                                           f"{LOW_PCT_MIN}..{LOW_PCT_MAX}")
                new[k] = v
            elif k in OPTION_DEFAULTS:
                if not isinstance(v, bool):
                    return _refuse(ctx, p, f"power_options: {k} must be true or false")
                new[k] = v
            elif k == "ignore":
                if not isinstance(v, list) or not all(isinstance(i, str) for i in v):
                    return _refuse(ctx, p, "power_options: ignore must be a list of conflict ids")
                bad = [i for i in v if i not in IGNORABLE]
                if bad:
                    return _refuse(ctx, p, f"power_options: {bad[0]!r} cannot be ignored")
                new[k] = sorted(set(v))
            else:
                return _refuse(ctx, p, f"power_options: unknown option {k!r}")
        old = {k: copy.deepcopy(p.data[k]) for k in new}
        p.data.update(new)
        err = _save(p)
        if err:
            p.data.update(old)
            return _refuse(ctx, p, err)
        applied = None
        if "poll_s" in new:
            p.last_poll = None           # the next tick checks with the new rate
        low_changed = False
        if any(k.startswith("low_battery") for k in new):
            low_changed = _low_eval(ctx, p, _monotonic(), powerhw.ac_online(ctx), force=True)
        writes = {k: v for k, v in new.items() if k not in ("poll_s", "advisor")}
        if p.data["enabled"] and writes:
            cleared = _update_blocked(ctx, p) if "ignore" in new else False
            if (cleared or low_changed or writes != {k: old[k] for k in writes}) and _may_write(ctx, p):
                applied = _apply(ctx, p)
        return _changed(ctx, p, applied)


def set_values(ctx, key, slot, values) -> dict:
    with _LOCK:
        p = _get(ctx)
        if not isinstance(key, str) or key not in p.data["profiles"]:
            return _refuse(ctx, p, f"power_set: no profile {key!r} (create it first)")
        if slot not in ("main", "ac", "low"):
            return _refuse(ctx, p, f"power_set: slot must be 'main', 'ac' or 'low', not {slot!r}")
        if slot == "low" and key != "default":
            return _refuse(ctx, p, "power_set: only the Default profile has low-battery values")
        if not isinstance(values, dict):
            return _refuse(ctx, p, "power_set: values must be an object")
        clean = {}
        for f, v in values.items():
            if f not in FIELDS:
                return _refuse(ctx, p, f"power_set: unknown field {f!r}")
            ok, nv = _values_ok(f, v)
            if not ok:
                return _refuse(ctx, p, f"power_set: {nv}")
            clean[f] = nv
        old = copy.deepcopy(p.data["profiles"][key])
        prof = p.data["profiles"][key]
        # an empty slot starts as a copy: ac of main, low of the Battery preset
        start = {"ac": lambda: dict(prof["main"]), "low": _battery_values}
        merged = dict(start[slot]() if slot != "main" and prof.get(slot) is None else prof[slot])
        merged.update(clean)
        if _exclusive_broken(merged):
            return _refuse(ctx, p, f"power_set: {EXCLUSIVE}")
        if slot != "main" and prof.get(slot) is None:
            prof[slot] = start[slot]()
        prof[slot].update(clean)
        err = _save(p)
        if err:
            p.data["profiles"][key] = old
            return _refuse(ctx, p, err)
        applied = None
        _first_check(ctx, p)
        if p.data["enabled"] and p.blocked is None:
            akey, aslot, _v = _active(p, powerhw.ac_online(ctx), ctx)
            if (akey, aslot) == (key, slot) or (slot == "low" and aslot == "low"):
                p.run["overridden"] = None     # a change to what runs: the user takes control again
                applied = _apply(ctx, p)
        return _changed(ctx, p, applied)


def profile(ctx, appid, name, on) -> dict:
    with _LOCK:
        p = _get(ctx)
        if isinstance(appid, int) and not isinstance(appid, bool):
            appid = str(appid)
        if not isinstance(appid, str) or not _APPID.match(appid):
            return _refuse(ctx, p, f"power_profile: {appid!r} is not a Steam app id (the default cannot be "
                                   "created or deleted)")
        if name is not None and not (isinstance(name, str) and len(name) <= MAX_NAME):
            return _refuse(ctx, p, f"power_profile: the name must be text of at most {MAX_NAME} characters")
        if not isinstance(on, bool):
            return _refuse(ctx, p, "power_profile: on must be true or false")
        profiles = p.data["profiles"]
        ac = powerhw.ac_online(ctx)
        before = _active(p, ac, ctx)[:2]
        old = copy.deepcopy(profiles.get(appid))
        if on:
            if appid in profiles:
                if name is not None:
                    profiles[appid]["name"] = name
            else:
                if len(profiles) - 1 >= MAX_PROFILES:
                    return _refuse(ctx, p, f"power_profile: at most {MAX_PROFILES} game profiles")
                d = profiles["default"]
                profiles[appid] = {"name": name, "main": dict(d["main"]),
                                   "ac": None if d["ac"] is None else dict(d["ac"])}
        else:
            profiles.pop(appid, None)
        err = _save(p)
        if err:
            if old is None:
                profiles.pop(appid, None)
            else:
                profiles[appid] = old
            return _refuse(ctx, p, err)
        applied = None
        if _may_write(ctx, p) and _active(p, ac, ctx)[:2] != before:
            applied = _apply(ctx, p)
        return _changed(ctx, p, applied)


def _order(order) -> tuple[str, int] | None | str:
    """power_game's order [session, seq] as a tuple, None for none, or why it is not one."""
    if order is None:
        return None
    if (isinstance(order, (list, tuple)) and len(order) == 2 and isinstance(order[0], str)
            and 0 < len(order[0]) <= 64 and isinstance(order[1], int) and not isinstance(order[1], bool)
            and order[1] >= 0):
        return order[0], order[1]
    return f"power_game: {order!r} is not an order"


def game(ctx, appid, order=None) -> dict:
    """The main running game is appid (None: none). order = [session, seq] from the frontend: a call with a lower
    seq than one already seen from the same session is older (it arrived late) and changes nothing."""
    with _LOCK:
        p = _get(ctx)
        if isinstance(appid, int) and not isinstance(appid, bool):
            appid = str(appid)
        if appid is not None and not (isinstance(appid, str) and _APPID.match(appid)):
            return _refuse(ctx, p, f"power_game: {appid!r} is not a Steam app id")
        o = _order(order)
        if isinstance(o, str):
            return _refuse(ctx, p, o)
        if o is not None:
            last = p.game_order
            if last is not None and last[0] == o[0] and o[1] < last[1]:
                return {**_changed(ctx, p, None), "stale": True}
            p.game_order = o
        if appid == "0":
            appid = None
        ac = powerhw.ac_online(ctx)
        before = _active(p, ac, ctx)[:2]
        changed = p.run.get("app") != appid
        p.run["app"] = appid
        if changed:
            _save_run(ctx, p)
        applied = None
        if _may_write(ctx, p) and _active(p, ac, ctx)[:2] != before:
            applied = _apply(ctx, p)
        return _changed(ctx, p, applied)


def take_control(ctx) -> dict:
    with _LOCK:
        p = _get(ctx)
        if not p.data["enabled"]:
            return _refuse(ctx, p, "TDP control is off")
        _rows(ctx, p, force=True)
        _update_blocked(ctx, p)
        if p.blocked:
            return _refuse(ctx, p, p.blocked, conflicts=_blockers(p))
        p.run["overridden"] = None
        return _changed(ctx, p, _apply(ctx, p))


# ---- Fix for me, Undo (only ever from the user's call after a confirm: never from tick or an event) ---------------

def _show(unit: str) -> tuple[dict | None, str | None]:
    """({LoadState, UnitFileState, ActiveState} of `unit`, or None, and why not)."""
    r = sysexec.run([_systemctl(), "show", "--property=LoadState,UnitFileState,ActiveState", "--", unit],
                    timeout=10)
    if r.rc != 0:
        return None, f"{unit}: {_last_line(r, f'systemctl show exited {r.rc}')}"
    got = {}
    for line in r.out.splitlines():
        k, sep, v = line.partition("=")
        if sep and k in ("LoadState", "UnitFileState", "ActiveState"):
            got[k] = v.strip()
    return got, None


def _systemctl_do(action: str, units: list[str]) -> tuple[bool, str | None]:
    """systemctl --no-ask-password <action> -- <units>: (ok, the error's last line)."""
    if not units:
        return True, None
    r = sysexec.run([_systemctl(), "--no-ask-password", action, "--", *units], timeout=FIX_TIMEOUT_S)
    if r.rc == 0:
        return True, None
    err = _last_line(r, f"systemctl {action} exited {r.rc}")
    log.warning("power: systemctl %s %s failed: %s", action, " ".join(units), err)
    return False, (err if len(units) != 1 or err.startswith(units[0]) else f"{units[0]}: {err}")


def _fix_answer(ctx, p: _Power, ok: bool, error: str | None, steps=None, notes=None, applied=None) -> dict:
    return {"ok": ok, "error": error, "steps": steps or [], "notes": notes or [], "state": _safe_state(ctx, p),
            "conflicts": _present(p), "fixed": _fixed_all(p), "applied": applied}


def _systemctl_ok(p: _Power) -> str | None:
    """Why Fix for me / Undo cannot run now (the last check could not list services), else None."""
    bad = [r for r in p.rows or [] if r["id"] == "unknown"]
    return bad[0]["why"] if bad else None


def _after_change(ctx, p: _Power, apply_cpu: bool) -> dict | None:
    """Look again after a fix or undo: a blocker that has gone lets tick apply now; a fixed "cpu" conflict makes EPP
    and turbo ours again, written at once. tick looks again FIX_RECHECK_S later (a D-Bus restart)."""
    now = _monotonic()
    _rows(ctx, p, force=True)
    if _update_blocked(ctx, p):
        p.apply_at = now
    p.recheck_at = now + FIX_RECHECK_S if p.data["enabled"] else None
    if apply_cpu and _may_write(ctx, p):
        return _apply(ctx, p)
    return None


def _lpmd_note(ctx, p: _Power) -> str | None:
    # OXP3 Deck's own speed cap is not a leftover. Not "cpu/max_pct in ours": the cap is always in the target (a
    # blank cap is the snapshot's value), so that would hide intel_lpmd's leftover.
    if p.data["enabled"] and "cpu/max_pct" in p.run["ours"] and \
            _active(p, powerhw.ac_online(ctx), ctx)[2].get("cpu_max_pct") is not None:
        return None
    raw = _text(ctx.sys_path("/sys/devices/system/cpu/intel_pstate/max_perf_pct"), 16)
    if raw.isdigit() and int(raw) < 100:
        return f"Intel's low-power daemon left the CPU's top speed at {int(raw)} %; a reboot restores it"
    return None


def _admin_override(ctx, unit: str) -> str | None:
    """Why `unit` must not be masked: /etc/systemd/system/<unit> already exists (an admin's own copy or link of the
    unit; `mask` would have to replace it), else None. A link to /dev/null there while the unit still reads loaded
    is someone else's mask systemd has not loaded yet: masking "again" would record was_masked false and Undo would
    remove that mask, so it is refused too."""
    path = ctx.sys_path(f"/etc/systemd/system/{unit}")
    try:
        if os.path.islink(path) and os.readlink(path) == "/dev/null":
            return (f"{unit} is already masked in /etc/systemd/system (not loaded by systemd yet), so OXP3 Deck "
                    "will not mask it; nothing was changed. Reboot, or run sudo systemctl daemon-reload")
    except OSError:
        pass
    if os.path.lexists(path):
        return (f"{unit} has its own unit file in /etc/systemd/system (an admin override), so OXP3 Deck will not "
                "mask it; nothing was changed. Turn it off yourself (Details: Do it yourself)")
    return None


def _ours_masked(u: dict) -> bool:
    """A record entry of a unit OXP3 Deck masked (older records have no was_masked: never unmasked)."""
    return u.get("was_masked") is False and u.get("unit") in MASKABLE


def fix(ctx, cid) -> dict:
    """PowerFixRes: stop, disable and (MASKABLE units only) mask the FIXABLE units of conflict `cid` (after the user
    confirmed it), recorded in power.json first so Undo works even after a crash half-way. Never uninstalls."""
    with _LOCK:
        p = _get(ctx)
        if not (isinstance(cid, str) and cid in FIXABLE):
            return _fix_answer(ctx, p, False, f"power_fix: {cid!r} cannot be fixed by OXP3 Deck")
        name = CONFLICTS[cid][0]
        _rows(ctx, p, force=True)
        why = _systemctl_ok(p)
        if why:
            return _fix_answer(ctx, p, False, why)
        row = next((r for r in p.rows or [] if r["id"] == cid), None)
        if row is None:
            return _fix_answer(ctx, p, False, f"{name} is not running")
        old = {u["unit"]: u for u in (p.data["fixed"].get(cid) or {}).get("units", [])}
        if not row["fix_units"]:
            masked = [u for u in FIXABLE[cid] if (p.loaded or {}).get(u) == "masked"]
            if any(u in old and _ours_masked(old[u]) for u in masked):
                return _fix_answer(ctx, p, False, f"{name} is running although OXP3 Deck masked it (it was not "
                                   "stopped, or was started outside systemd); a restart stops it, Undo unmasks it")
            if masked:
                return _fix_answer(ctx, p, False, f"{name} is masked; OXP3 Deck does not unmask services")
            return _fix_answer(ctx, p, False, f"{name} was not started by systemd: OXP3 Deck cannot turn it off")
        seen: dict = {}
        for unit in row["fix_units"]:
            got, err = _show(unit)
            if got is None:
                return _fix_answer(ctx, p, False, err)
            if got.get("LoadState") != "loaded":         # not-found, masked: nothing to do
                continue
            seen[unit] = got
        if not seen:
            return _fix_answer(ctx, p, False, f"{name}: no service of it is loaded")
        for unit in seen:
            override = _admin_override(ctx, unit) if unit in MASKABLE else None
            if override:
                return _fix_answer(ctx, p, False, override)
        units = []
        for unit, got in seen.items():
            was_enabled = got.get("UnitFileState", "")[:32]
            was_active = got.get("ActiveState") in _ACTIVE
            if unit in old:       # Fix again: keep the state from before OXP3 Deck first touched it, but an enable
                # that this fix is about to remove (something enabled it again) is what Undo must put back
                if was_enabled != "enabled":
                    was_enabled = old[unit]["was_enabled"]
                was_active = was_active or old[unit]["was_active"]
            entry = {"unit": unit, "was_enabled": was_enabled, "was_active": was_active}
            if unit in MASKABLE:
                entry["was_masked"] = False
            units.append(entry)
        for k, u in old.items():  # the record's other units: kept while they still exist (Undo has work there)
            if k not in seen:
                got, _err = _show(k)
                if got is None or got.get("LoadState") == "loaded" or \
                        (got.get("LoadState") == "masked" and _ours_masked(u)):
                    units.append(u)
        before = copy.deepcopy(p.data["fixed"])
        p.data["fixed"][cid] = {"at": time.time(), "boot_id": _boot_id(ctx)[:64], "units": units}
        err = _save(p)
        if err:
            p.data["fixed"] = before
            return _fix_answer(ctx, p, False, f"nothing was changed: cannot save the record for Undo: {err}")
        plan = (("stop", [u for u, g in seen.items() if g.get("ActiveState") in _ACTIVE]),
                ("disable", [u for u, g in seen.items() if g.get("UnitFileState") == "enabled"]),
                ("mask", [u for u in seen if u in MASKABLE]))
        log.info("power: Fix for me %s: %s", cid, ", ".join(f"{a} {' '.join(t) or '-'}" for a, t in plan))
        errors = []
        results = {}
        for action, todo in plan:
            ok, e = _systemctl_do(action, todo)
            results[action] = (ok, e)
            if e:
                errors.append(e)
        if plan[2][1] and results["mask"][0]:      # started again between the stop and the mask: stop it once more
            again = [u for u in plan[2][1] if ((_show(u)[0] or {}).get("ActiveState") in _ACTIVE)]
            if again:
                log.info("power: Fix for me %s: %s started again before the mask, stopping it again", cid, again)
                ok, e = _systemctl_do("stop", again)
                if e:
                    errors.append(e)
        steps = []
        for action, todo in plan:
            ran_ok, ran_err = results[action]
            for unit in todo:
                after, show_err = _show(unit)
                if not ran_ok:
                    error = ran_err
                elif after is None:
                    error = show_err
                elif action == "disable" and after.get("UnitFileState") == "enabled":
                    error = f"{unit}: still enabled"
                elif action == "stop" and after.get("ActiveState") in _ACTIVE:
                    error = f"{unit}: running again"
                elif action == "mask" and after.get("LoadState") != "masked":
                    error = f"{unit}: not masked"
                else:
                    error = None
                steps.append({"unit": unit, "action": action, "ok": error is None, "error": error})
        applied = _after_change(ctx, p, CONFLICTS[cid][1] == "cpu")
        notes = []
        if cid == "intel_lpmd":
            note = _lpmd_note(ctx, p)
            if note:
                notes.append(note)
        gone = all(r["id"] != cid for r in p.rows or [])
        if errors:
            return _fix_answer(ctx, p, False, errors[-1], steps, notes, applied)
        if not gone:
            return _fix_answer(ctx, p, False, f"{name} is still running", steps, notes, applied)
        return _fix_answer(ctx, p, True, None, steps, notes, applied)


def fix_all(ctx, cids) -> dict:
    """PowerFixAllRes: "Fix all": fix() for each conflict id of `cids` in turn (after one confirm that listed them),
    all under one hold of _LOCK so no tick or other call runs in between. Each fix keeps its own record, so Undo
    stays per item; a failed one does not stop the rest. `results`: per id, in the order sent."""
    with _LOCK:
        p = _get(ctx)
        if not (isinstance(cids, list) and 0 < len(cids) <= len(FIXABLE) and all(isinstance(c, str) for c in cids)):
            return {"ok": False, "error": "power_fix_all: expected a list of conflict ids", "results": [],
                    "state": _safe_state(ctx, p), "conflicts": _present(p), "fixed": _fixed_all(p), "applied": None}
        results = []
        applied = None
        for cid in dict.fromkeys(cids):          # each id once, in the order sent
            r = fix(ctx, cid)
            results.append({"id": cid, "ok": r["ok"], "error": r["error"], "steps": r["steps"], "notes": r["notes"]})
            applied = r["applied"] or applied
        bad = [r for r in results if not r["ok"]]
        if not bad:
            error = None
        elif len(bad) == 1:
            error = bad[0]["error"]
        else:
            error = f"{len(bad)} of {len(results)} were not turned off"
        log.info("power: Fix all %s: %s", ", ".join(r["id"] for r in results),
                 "ok" if not bad else f"failed: {', '.join(r['id'] for r in bad)}")
        return {"ok": not bad, "error": error, "results": results, "state": _safe_state(ctx, p),
                "conflicts": _present(p), "fixed": _fixed_all(p), "applied": applied}


def unfix(ctx, cid) -> dict:
    """PowerFixRes: Undo of fix(): unmask what it masked, then enable what was enabled, start what was running,
    nothing else."""
    with _LOCK:
        p = _get(ctx)
        if not (isinstance(cid, str) and cid in FIXABLE and cid in p.data["fixed"]):
            return _fix_answer(ctx, p, False, f"power_unfix: OXP3 Deck has turned nothing off for {cid!r}")
        _rows(ctx, p, force=True)
        why = _systemctl_ok(p)
        if why:
            return _fix_answer(ctx, p, False, why)
        rec = p.data["fixed"][cid]
        units = []
        unmask = []
        notes = []
        gone_note = "{} is no longer installed (or is masked); nothing to turn back on"
        for u in rec["units"]:
            if u["unit"] not in FIXABLE[cid]:
                continue
            got, _err = _show(u["unit"])
            if got is not None and got.get("LoadState") == "masked" and _ours_masked(u):
                unmask.append(u["unit"])                                  # OXP3 Deck's own mask: undone first
            elif got is not None and got.get("LoadState") != "loaded":    # not-found (uninstalled) or masked
                notes.append(gone_note.format(u["unit"]))
                continue
            units.append(u)
        log.info("power: Undo %s: unmask %s", cid, unmask or "-")
        failed: set = set()
        errors = []
        steps = []
        if unmask:
            ok, e = _systemctl_do("unmask", unmask)
            if not ok:
                failed |= set(unmask)
                errors.append(e)
            steps += [{"unit": u, "action": "unmask", "ok": ok, "error": e} for u in unmask]
            if ok:          # masked and then uninstalled: unmasked, but there is nothing to turn back on
                for unit in unmask:
                    got, _err = _show(unit)
                    if got is not None and got.get("LoadState") != "loaded":
                        notes.append(gone_note.format(unit))
                        units = [u for u in units if u["unit"] != unit]
        todo_units = [u for u in units if u["unit"] not in failed]
        enable = [u["unit"] for u in todo_units if u["was_enabled"] == "enabled"]
        start = [u["unit"] for u in todo_units if u["was_active"]]
        log.info("power: Undo %s: enable %s, start %s", cid, enable or "-", start or "-")
        for action, todo in (("enable", enable), ("start", start)):
            ok, e = _systemctl_do(action, todo)
            if not ok:
                failed |= set(todo)
                errors.append(e)
            steps += [{"unit": u, "action": action, "ok": ok, "error": e} for u in todo]
        applied = None
        left = [u for u in units if u["unit"] in failed]
        if left:
            p.data["fixed"][cid] = dict(rec, units=left)
        else:
            p.data["fixed"].pop(cid, None)
        err = _save(p)
        if err:
            errors.append(f"cannot save power.json: {err}")
        _after_change(ctx, p, False)
        return _fix_answer(ctx, p, not errors, errors[-1] if errors else None, steps, notes, applied)


def _drift_period(p: _Power, now: float) -> int:
    """N-7: the drift check's period. poll_s, but max(poll_s, GAME_POLL_S) while a game runs with no panel showing
    and nothing unsettled (an apply, a drift, a pending retry) in the last CALM_S, outside a grace window. 0: Off."""
    poll = p.data["poll_s"]
    if poll <= 0:
        return 0
    busy = (p.run.get("app") is None
            or (p.panel_at is not None and now - p.panel_at < PANEL_RECENT_S)
            or (p.grace_until is not None and now < p.grace_until)
            or (p.pending and p.pending_left > 0)
            or (p.unsettled_at is not None and now - p.unsettled_at < CALM_S))
    return poll if busy else max(poll, GAME_POLL_S)


def _low_eval(ctx, p: _Power, now: float, ac, force: bool = False) -> bool:
    """The low-battery slot's conditions (N-4): enter on battery (never with AC unknown) at <= low_battery_pct,
    leave on AC or at >= low_battery_pct + LOW_HYST_PCT. The charge is read every LOW_CHECK_S (force: now, after an
    AC change or an option change), never on AC. True when run.low changed (saved)."""
    cur = p.run.get("low")
    if not (p.data["enabled"] and p.data["low_battery"]) or ac is True:
        if cur is not None:
            p.run["low"] = None
            log.info("power: low battery: back to the profile's own values")
            _save_run(ctx, p)
            return True
        return False
    if not force and p.low_at is not None and now - p.low_at < LOW_CHECK_S:
        return False
    p.low_at = now
    pct = powerhw.battery(ctx)["pct"]
    p.low_pct = pct
    thr = p.data["low_battery_pct"]
    if cur is None:
        if ac is False and pct is not None and pct <= thr:
            p.run["low"] = {"since": time.time(), "pct": pct}
            log.info("power: low battery (%d %%): battery-saving values until %d %% or AC", pct, thr + LOW_HYST_PCT)
            _save_run(ctx, p)
            return True
        return False
    if pct is not None and pct >= thr + LOW_HYST_PCT:
        p.run["low"] = None
        log.info("power: battery at %d %%: back to the profile's own values", pct)
        _save_run(ctx, p)
        return True
    cur["pct"] = pct if pct is not None else cur.get("pct")
    return False


def tick(ctx) -> dict:
    """One step of the watch loop (every TICK_S): resume and AC changes, the boot apply, drift and conflicts."""
    with _LOCK:
        p = _get(ctx)
        now = _monotonic()
        susp = powerhw.suspend_count(ctx)
        ac = powerhw.ac_online(ctx)
        gap = _clock_gap()
        resumed = ac_changed = False
        if p.seen:
            resumed = ((susp is not None and p.prev_susp is not None and susp > p.prev_susp)
                       or (gap is not None and p.prev_gap is not None and gap - p.prev_gap > BOOTTIME_JUMP_S))
            ac_changed = ac != p.prev_ac
        if susp is not None and susp != p.run.get("suspend_count"):
            p.run["suspend_count"] = susp
        p.seen, p.prev_susp, p.prev_ac, p.prev_gap = True, susp, ac, gap
        if not p.data["enabled"]:
            p.apply_at = p.grace_until = p.recheck_at = None
            _low_eval(ctx, p, now, ac)            # clears a low state left from before
            return {"ok": True, "error": None, "did": "idle"}
        _hw(ctx, p)
        if resumed:
            log.info("power: resumed; applying in %d s", RESUME_DELAY_S)
            p.apply_at = max(p.apply_at or 0, now + RESUME_DELAY_S)
            p.grace_until = max(p.grace_until or 0, now + GRACE_S)
            p.grace_left = GRACE_REAPPLIES
        if ac_changed:
            p.apply_at = max(p.apply_at or 0, now + AC_DEBOUNCE_S)   # after the last change of a flapping charger
            p.grace_until = max(p.grace_until or 0, now + GRACE_S)
            p.grace_left = GRACE_REAPPLIES
        if _low_eval(ctx, p, now, ac, force=ac_changed) and p.blocked is None and not p.run.get("overridden") \
                and p.apply_at is None:
            p.apply_at = now
        recheck = p.recheck_at is not None and now >= p.recheck_at
        if recheck or p.rows_at is None or now - p.rows_at >= CONFLICT_RECHECK_S:
            p.recheck_at = None
            _rows(ctx, p, force=True)
            if _update_blocked(ctx, p):
                log.info("power: the other power manager is gone; applying again")
                p.apply_at = now
        if p.blocked:
            return {"ok": True, "error": None, "did": "blocked"}
        if p.run.get("overridden"):
            p.apply_at = None
            return {"ok": True, "error": None, "did": "overridden"}
        if not p.started:
            res = _apply(ctx, p)       # the boot apply (after a plugin reload it usually writes nothing)
            p.apply_at = None if p.apply_at is not None and p.apply_at <= now else p.apply_at
            return {"ok": True, "error": None, "did": "applied" if res["written"] else "nothing"}
        if p.apply_at is not None:
            if now < p.apply_at:
                return {"ok": True, "error": None, "did": "nothing"}
            p.apply_at = None
            _apply(ctx, p)
            return {"ok": True, "error": None, "did": "applied"}
        if p.grace_until is not None and now >= p.grace_until:
            p.grace_until = None
        # the drift check and the retry of what the device did not take: every poll_s (0: Off), and every tick
        # inside a grace window (after AC or resume)
        poll = p.data["poll_s"]
        period = _drift_period(p, now)
        due = p.grace_until is not None or (poll > 0 and (p.last_poll is None or now - p.last_poll >= period))
        if not due:
            return {"ok": True, "error": None, "did": "nothing"}
        p.last_poll = now
        d = _drift(p, powerhw.read(ctx, p.hw, gpu=False), gpu_only=False)
        if d is not None:
            return {"ok": True, "error": None, "did": _on_drift(ctx, p, d, now, confirm=True)}
        p.drift_seen = None
        if p.pending and p.pending_left > 0:
            p.pending_left -= 1
            res = _apply(ctx, p, retry=True)      # writes only what differs: never over another program (no drift)
            return {"ok": True, "error": None, "did": "applied" if res["written"] else "nothing"}
        return {"ok": True, "error": None, "did": "nothing"}


def active(ctx) -> dict:
    """The active profile for extras.py: {key, slot, app, ac, enabled, values} (the stored slot, whether or not TDP
    control is on). No hardware read but ac_online."""
    with _LOCK:
        p = _get(ctx)
        ac = powerhw.ac_online(ctx)
        key, slot, values = _active(p, ac, ctx)
        return {"key": key, "slot": slot, "app": p.run.get("app"), "ac": ac, "enabled": p.data["enabled"],
                "values": dict(values)}


def refresh(ctx) -> dict:
    """Apply at the next tick (when writing is allowed): main.py calls it after extras paused or resumed
    intel_lpmd, which stops or starts blocking fields."""
    with _LOCK:
        p = _get(ctx)
        if _may_write(ctx, p):
            p.apply_at = _monotonic()
        return {"ok": True, "error": None}


def summary(ctx) -> dict:
    """PowerSummary for get_overview: no GPU read, no systemctl."""
    with _LOCK:
        p = _get(ctx)
        out = {"ok": True, "error": None, "enabled": p.data["enabled"], "line": "Off",
               "overridden": p.run.get("overridden") is not None, "blocked": p.blocked}
        if not p.data["enabled"]:
            return out
        hw = _hw(ctx, p)
        r = powerhw.read(ctx, hw, gpu=False)
        key, _slot, _v = _active(p, r.get("ac"), ctx)
        pl1s = [v["pl1_uw"] for v in r["rapl"].values() if v.get("pl1_uw") is not None]
        pl2s = [v["pl2_uw"] for v in r["rapl"].values() if v.get("pl2_uw") is not None]
        parts = []
        if pl1s:
            parts.append(f"{_w(min(pl1s)):g} W" + (f" / {_w(min(pl2s)):g} W" if pl2s else ""))
        parts.append(_profile_name(p, key))
        out["line"] = " · ".join(parts)
        return out


# ---- the sampler's context and the self-test (DESIGN.md "Performance batch" B, E) ----------------------------------

def game_now(ctx) -> dict:
    """What the sampler and the self-test need, with no sysfs read: {app, name, enabled, blocked, overridden, grace,
    ac (the last tick's), key, slot, pl1_w / pl2_w (the lowest of what the last apply left on the zones, W, or None),
    pl1_min, pl1_max, pl1_max_ac (None until a snapshot exists), low, testing, advisor}."""
    with _LOCK:
        p = _get(ctx)
        now = _monotonic()
        ac = p.prev_ac
        key, slot, _v = _active(p, ac, ctx)
        ours = p.run.get("ours") or {}
        pl1s = [v for k, v in ours.items() if k.endswith("/pl1") and not k.startswith(("gpu/", "cpu/", "soc/"))
                and isinstance(v, int)]
        pl2s = [v for k, v in ours.items() if k.endswith("/pl2") and isinstance(v, int)]
        rng = None
        if p.hw is not None and p.run.get("snapshot") and p.oxp3 is not None:
            rng = _limits(ctx, p, p.hw, ac)            # from the snapshot: no read
        app = p.run.get("app")
        return {"app": app, "name": (p.data["profiles"].get(app) or {}).get("name") if app else None,
                "enabled": p.data["enabled"], "blocked": p.blocked, "overridden": p.run.get("overridden") is not None,
                "grace": p.grace_until is not None and now < p.grace_until, "ac": ac, "key": key, "slot": slot,
                "pl1_w": _w(min(pl1s)) if pl1s else None, "pl2_w": _w(min(pl2s)) if pl2s else None,
                "pl1_min": MIN_W, "pl1_max": rng["pl1_max"] if rng else None,
                "pl1_max_ac": rng["pl1_max_ac"] if rng else None,
                "low": slot == "low", "testing": p.testing, "advisor": p.data["advisor"]}


def time_windows(ctx) -> dict:
    """powerhw.time_windows for the discovered zones (read only)."""
    with _LOCK:
        p = _get(ctx)
        return powerhw.time_windows(ctx, _hw(ctx, p))


def selftest_mark(ctx, on: bool) -> dict:
    """The self-test starts (on: the boot snapshot is taken first) or ends (off: the active profile is applied when
    writing is allowed; it writes only what differs). {ok, error, applied}."""
    with _LOCK:
        p = _get(ctx)
        applied = None
        if on:
            _hw(ctx, p)
            _ensure_snapshot(ctx, p)
            p.testing = True
        else:
            p.testing = False
            if _may_write(ctx, p):
                applied = _apply(ctx, p)
        return {"ok": True, "error": None, "applied": applied}


PROBE_W, PROBE_MHZ, PROBE_PCT, PROBE_CAP_MHZ = 1, 50, 5, 200   # selftest.py's steps (kept equal by a test)
_EPP_NEXT = {"balance_performance": "balance_power", "balance_power": "balance_performance",
             "performance": "balance_performance", "power": "balance_power"}
_TYPE_NAME = {"p": "P cores", "e": "E cores", "lpe": "LP-E cores"}


def _probe_label(hw: dict, item: str) -> str:
    if item.endswith(("/pl1", "/pl2")) and not item.startswith(("gpu/", "cpu/")):
        zid, _, k = item.rpartition("/")
        iface = "MMIO" if zid.startswith("intel-rapl-mmio") else "MSR"
        return f"{'Sustained' if k == 'pl1' else 'Boost'} power ({iface})"
    if item.startswith("cpu/cap/"):
        pol = item[len("cpu/cap/"):]
        t = _policy_types(hw).get(pol, "p")
        return f"Per-core speed cap ({_TYPE_NAME.get(t, t)})"
    return {"gpu/max": "GPU maximum speed", "gpu/min": "GPU minimum speed", "epp": "Energy preference",
            "turbo": "CPU boost", "cpu/max_pct": "CPU speed cap", "cpu/min_pct": "CPU speed floor",
            "soc/balance": "SoC power slider", "gpu/profile": "GPU power profile"}.get(item, item)


def _left_to(ctx, p: _Power, group: str | None) -> str | None:
    """Why the self-test leaves a field group alone: blocked by, or yielded to, another program."""
    if group is None:
        return None
    blocked = _blocked_fields(ctx, p)
    ids = blocked.get(group) or p.yielded.get(group)
    if not ids:
        return None
    names = ", ".join(CONFLICTS[i][0] if i in CONFLICTS else i for i in ids)
    return f"left to {names}"


def probe_plan(ctx) -> list[dict]:
    """The self-test's probes for what OXP3 Deck controls on this device, from a fresh read: each {id, label, probe:
    Target, restore: Target, before, tried} (raw values: µW, MHz, kHz, %, words), or with `skip` (outcome) and
    `why` instead of the targets. The restore target is the value read just before, so "previous" comes back."""
    with _LOCK:
        p = _get(ctx)
        hw = _hw(ctx, p)
        r = powerhw.read(ctx, hw, gpu=hw.get("gpu") is not None)
        rng = _limits(ctx, p, hw, r.get("ac"), r)
        locked = set(p.run["locked"])
        plan: list[dict] = []

        def add(item, probe=None, restore=None, before=None, tried=None, skip=None, why=None):
            row = {"id": item, "label": _probe_label(hw, item), "before": before, "tried": tried}
            if skip:
                row.update(skip=skip, why=why)
            else:
                row.update(probe=probe, restore=restore)
            plan.append(row)

        step = _uw(PROBE_W)
        for z in hw.get("rapl") or []:
            cur = r["rapl"].get(z["id"]) or {}
            pl1, pl2 = cur.get("pl1_uw"), cur.get("pl2_uw")
            item = f"{z['id']}/pl1"
            if item in locked:
                add(item, before=pl1, skip="locked", why="locked earlier this boot")
            elif not pl1:
                add(item, before=pl1, skip="unsupported", why="unreadable")
            else:
                v = pl1 - step
                if v < _uw(MIN_W):
                    v = pl1 + step
                if pl2 and v > pl2 and z.get("pl2"):
                    add(item, before=pl1, skip="skipped", why="no room between the limits")
                else:
                    add(item, {"rapl": {z["id"]: {"pl1_uw": v}}}, {"rapl": {z["id"]: {"pl1_uw": pl1}}}, pl1, v)
            item = f"{z['id']}/pl2"
            if not z.get("pl2"):
                add(item, skip="skipped", why="this interface has no boost limit")
            elif item in locked:
                add(item, before=pl2, skip="locked", why="locked earlier this boot")
            elif not pl2:
                add(item, before=pl2, skip="unsupported", why="unreadable")
            else:
                v = pl2 - step
                if pl1 and v < pl1:
                    v = pl2 + step
                if v > _uw(rng["pl2_max"]) or (pl1 and v < pl1):
                    add(item, before=pl2, skip="skipped", why="no room between the limits")
                else:
                    add(item, {"rapl": {z["id"]: {"pl2_uw": v}}}, {"rapl": {z["id"]: {"pl2_uw": pl2}}}, pl2, v)
        g = hw.get("gpu")
        rg = r.get("gpu") or {}
        if not g:
            for item in ("gpu/max", "gpu/min"):
                add(item, skip="skipped", why="no xe GPU")
        else:
            lo, hi = rg.get("min"), rg.get("max")
            if lo is None or hi is None:
                for item in ("gpu/max", "gpu/min"):
                    add(item, skip="unsupported", why="unreadable")
            else:
                v = hi - PROBE_MHZ
                if v < lo:
                    add("gpu/max", before=hi, skip="skipped", why="no room between the GPU limits")
                else:
                    add("gpu/max", {"gpu": {"max": v}}, {"gpu": {"max": hi}}, hi, v)
                v = lo + PROBE_MHZ
                if v > hi:
                    v = lo - PROBE_MHZ
                if v < g["rpn"] or v > hi:
                    add("gpu/min", before=lo, skip="skipped", why="no room between the GPU limits")
                else:
                    add("gpu/min", {"gpu": {"min": v}}, {"gpu": {"min": lo}}, lo, v)
        cpu = hw.get("cpu") or {}
        pol0 = (cpu.get("policies") or [None])[0]
        if cpu.get("epp") and pol0:
            before = (r.get("epp") or {}).get(pol0)
            nxt = _EPP_NEXT.get(before or "")
            why = _left_to(ctx, p, "epp")
            if r.get("governor") == "performance":
                add("epp", before=before, skip="skipped", why="the CPU governor is performance")
            elif why:
                add("epp", before=before, skip="skipped", why=why)
            elif nxt is None or nxt not in (cpu.get("epp_choices") or []):
                add("epp", before=before, skip="skipped", why=f"no neighbour of {before or 'unreadable'} offered")
            else:
                add("epp", {"epp": {pol0: nxt}}, {"epp": {pol0: before}}, before, nxt)
        if cpu.get("turbo"):
            why = _left_to(ctx, p, "turbo")
            if why:
                add("turbo", before=r.get("turbo"), skip="skipped", why=why)
            elif r.get("turbo") is not True:
                add("turbo", before=r.get("turbo"), skip="skipped", why="not tried: CPU boost is off")
            else:
                restore: dict = {"turbo": True}
                caps = {k: v for k, v in (r.get("caps") or {}).items() if isinstance(v, int)}
                if caps and not _left_to(ctx, p, "cpu_caps"):
                    restore["caps"] = caps          # intel_pstate clamps the caps while boost is off
                perf = r.get("perf") or {}
                if cpu.get("perf_pct") and isinstance(perf.get("max"), int) and isinstance(perf.get("min"), int) \
                        and not _left_to(ctx, p, "cpu_pct"):
                    restore["perf"] = {"max": perf["max"], "min": perf["min"]}
                add("turbo", {"turbo": False}, restore, True, False)
        if cpu.get("perf_pct"):
            perf = r.get("perf") or {}
            mx, mn = perf.get("max"), perf.get("min")
            why = _left_to(ctx, p, "cpu_pct")
            for item, k in (("cpu/max_pct", "max"), ("cpu/min_pct", "min")):
                before = perf.get(k)
                if why:
                    add(item, before=before, skip="skipped", why=why)
                    continue
                if mx is None or mn is None:
                    add(item, before=before, skip="unsupported", why="unreadable")
                    continue
                v = mx - PROBE_PCT if k == "max" else mn + 1
                ok = (v >= CPU_PCT_MIN and v >= mn) if k == "max" else (v <= mx and v <= CPU_MIN_PCT_MAX)
                if not ok:
                    add(item, before=before, skip="skipped", why="no room between the CPU speed limits")
                else:
                    add(item, {"perf": {k: v}}, {"perf": {k: before}}, before, v)
        caps = r.get("caps") or {}
        why = _left_to(ctx, p, "cpu_caps")
        for _t, pol in _first_policies(hw).items():
            item = f"cpu/cap/{pol}"
            before = caps.get(pol)
            if why:
                add(item, before=before, skip="skipped", why=why)
                continue
            if before is None:
                add(item, skip="unsupported", why="unreadable")
                continue
            lo = powerhw._int(powerhw._read(powerhw._policy_file(ctx, pol, "scaling_min_freq")))
            v = before - PROBE_CAP_MHZ * 1000
            if lo is not None and v < lo:
                add(item, before=before, skip="skipped", why="no room above the minimum speed")
            else:
                add(item, {"caps": {pol: v}}, {"caps": {pol: before}}, before, v)
        soc = r.get("soc")
        if hw.get("soc"):
            why = _left_to(ctx, p, "soc")
            b = (soc or {}).get("balance")
            if why:
                add("soc/balance", before=b, skip="skipped", why=why)
            elif not isinstance(b, int):
                add("soc/balance", skip="unsupported", why="unreadable")
            elif (soc or {}).get("profile") != "balanced":
                add("soc/balance", before=b, skip="skipped",
                    why="the platform profile is not balanced: the slider cannot be read back")
            else:
                v = b - 1 if b > 1 else b + 1
                add("soc/balance", {"soc": {"balance": v}}, {"soc": {"balance": b}}, b, v)
        if g and g.get("power_profile"):
            before = rg.get("profile")
            if before not in powerhw.GPU_PROFILES:
                add("gpu/profile", before=before, skip="unsupported", why="unreadable")
            else:
                v = "power_saving" if before == "base" else "base"
                add("gpu/profile", {"gpu_profile": v}, {"gpu_profile": before}, before, v)
        return plan


def _probe_got(item: str, reading: dict):
    """The value of probe `item` in a powerhw reading (raw)."""
    if item.startswith("cpu/cap/"):
        return (reading.get("caps") or {}).get(item[len("cpu/cap/"):])
    if item in ("gpu/max", "gpu/min"):
        return (reading.get("gpu") or {}).get(item[4:])
    if item == "gpu/profile":
        return (reading.get("gpu") or {}).get("profile")
    if item == "epp":
        epp = reading.get("epp") or {}
        return epp.get(sorted(epp, key=lambda k: int(k[6:]) if k[6:].isdigit() else 1 << 30)[0]) if epp else None
    if item == "turbo":
        return reading.get("turbo")
    if item in ("cpu/max_pct", "cpu/min_pct"):
        return (reading.get("perf") or {}).get(item[4:7])
    if item == "soc/balance":
        return (reading.get("soc") or {}).get("balance")
    zid, _, k = item.rpartition("/")
    return (reading.get("rapl") or {}).get(zid, {}).get(f"{k}_uw")


def _probe_same(item: str, a, b) -> bool:
    if a is None or b is None:
        return False
    if item.startswith("cpu/cap/"):
        return abs(a - b) <= powerhw.CAP_TOLERANCE_KHZ
    if item in ("gpu/max", "gpu/min"):
        return abs(a - b) <= powerhw.GPU_TOLERANCE_MHZ
    if item.endswith(("/pl1", "/pl2")):
        return abs(a - b) <= powerhw.RAPL_TOLERANCE_UW
    return a == b


def _probe_fails(res: dict) -> list[dict]:
    return [f for f in res["failed"] if not f["id"].endswith("/pl4")]


def probe(ctx, item: dict) -> dict:
    """One probe of probe_plan, atomic under the lock (the watch loop and the UI never see the probe value): write
    the probe target, then the restore target, each read back. A newly locked id joins the run's `locked`; `ours`
    is not touched. A restore that does not read back the old value re-applies the profile at once (when writing is
    allowed). SelftestProbe: {id, label, before, tried, read, restored, outcome, why}."""
    with _LOCK:
        p = _get(ctx)
        iid = item["id"]
        row = {"id": iid, "label": item.get("label") or iid, "before": _fmt(iid, item.get("before"))
               if item.get("before") is not None else None,
               "tried": _fmt(iid, item.get("tried")) if item.get("tried") is not None else None,
               "read": None, "restored": None, "outcome": "skipped", "why": None}
        if item.get("skip"):
            row.update(outcome=item["skip"], why=item.get("why"))
            return row
        if not _may_write(ctx, p):
            row["why"] = "power control is paused"
            return row
        hw = _hw(ctx, p)
        # something may have written between probe_plan and now (a slider, a preset, the low-battery slot, a
        # retry): the plan's restore target would then put back a stale value, so such a probe is skipped
        now = powerhw.read(ctx, hw, gpu=iid.startswith("gpu/") and hw.get("gpu") is not None)
        if not _probe_same(iid, _probe_got(iid, now), item.get("before")):
            row["why"] = "changed during the check"
            return row
        res = powerhw.apply(ctx, hw, item["probe"], p.run["locked"])
        fails = _probe_fails(res)
        newly = [f["id"] for f in fails if f.get("locked")]
        if newly:
            log.warning("power: self-test: locked by firmware this boot: %s", ", ".join(newly))
            p.run["locked"] = sorted(set(p.run["locked"]) | set(newly))
            _save_run(ctx, p)
        got = _probe_got(iid, res["reading"])
        row["read"] = _fmt(iid, got) if got is not None else None
        if newly:
            row.update(outcome="locked", why="locked by firmware")
        elif any(f["error"].startswith("did not take") for f in fails):
            row.update(outcome="ignored", why="the device kept its value")
        elif fails and all(f.get("transient") for f in fails):
            row.update(outcome="skipped", why="GPU busy or asleep, try again")
        elif fails:
            row.update(outcome="unsupported", why=fails[0]["error"])
        elif not _probe_same(iid, got, item["tried"]):
            row.update(outcome="ignored", why="the device kept its value")
        else:
            row["outcome"] = "ok"
        back = powerhw.apply(ctx, hw, item["restore"], p.run["locked"])
        now_v = _probe_got(iid, back["reading"])
        restored = not _probe_fails(back) and _probe_same(iid, now_v, item["before"])
        bad = f"reads {_fmt(iid, now_v)} after the restore"
        for pol, want in ((item["restore"].get("caps") or {}).items() if iid == "turbo" else ()):
            cap = (back["reading"].get("caps") or {}).get(pol)
            if not _probe_same("cpu/cap/" + pol, cap, want):      # intel_pstate clamps the caps while boost is off
                restored, bad = False, f"{pol} speed cap reads {_fmt('cpu/cap/' + pol, cap)} after the restore"
        row["restored"] = restored
        if not restored:
            log.warning("power: self-test: %s did not come back (%s): applying the profile again", iid, bad)
            row.update(outcome="not_restored", why=bad)
            if _may_write(ctx, p):
                _apply(ctx, p)
        return row


# ---- import from SimpleDeckyTDP ----------------------------------------------------------------------------------

_SDTDP_KEY = re.compile(r"^(default|\d{1,10})(-ac-power)?$")
_SDTDP_USED = {"tdp", "cpuBoost", "gpuMode", "minGpuFrequency", "maxGpuFrequency", "fixedGpuFrequency",
               "powerControls"}


def _sdtdp_values(prof: dict, label: str, skipped: list) -> dict:
    v = _empty_values()
    tdp = prof.get("tdp")
    if isinstance(tdp, (int, float)) and not isinstance(tdp, bool):
        v["pl1_w"] = int(_clamp(round(tdp), MIN_W, MAX_W))
    elif tdp is not None:
        skipped.append(f"{label}: tdp {tdp!r}")
    if isinstance(prof.get("cpuBoost"), bool):
        v["turbo"] = prof["cpuBoost"]
    mode = prof.get("gpuMode")

    def mhz(x):
        return int(_clamp(round(x), 0, MAX_MHZ)) if isinstance(x, (int, float)) and not isinstance(x, bool) \
            and x > 0 else None

    if mode == "RANGE":
        lo, hi = mhz(prof.get("minGpuFrequency")), mhz(prof.get("maxGpuFrequency"))
        if lo is not None and hi is not None:
            v["gpu_min_mhz"], v["gpu_max_mhz"] = min(lo, hi), max(lo, hi)
        else:
            skipped.append(f"{label}: gpuMode RANGE without frequencies")
    elif mode == "FIXED":
        f = mhz(prof.get("fixedGpuFrequency")) or mhz(prof.get("maxGpuFrequency"))
        if f is not None:
            v["gpu_min_mhz"] = v["gpu_max_mhz"] = f
        else:
            skipped.append(f"{label}: gpuMode FIXED without a frequency")
    elif mode is not None:
        skipped.append(f"{label}: gpuMode {mode}")
    pc = prof.get("powerControls")
    if isinstance(pc, dict):
        drivers = [pc.get("intel_pstate")] + [d for k, d in pc.items() if k != "intel_pstate"]
        for d in drivers:
            if isinstance(d, dict) and d.get("epp") in EPP_CHOICES:
                v["epp"] = d["epp"]
                break
        for d in drivers:
            if isinstance(d, dict) and "powerGovernor" in d:
                skipped.append(f"{label}: powerGovernor")
                break
    other = sorted(k for k in prof if k not in _SDTDP_USED)
    if other:
        skipped.append(f"{label}: {', '.join(other)}")
    return v


def import_sdtdp(ctx) -> dict:
    """SimpleDeckyTDP's profiles as OXP3 Deck profiles (its settings.json read as data; its files untouched)."""
    with _LOCK:
        p = _get(ctx)
        path = os.path.join(_homebrew(ctx), "settings", "SimpleDeckyTDP", "settings.json")

        def no(error):
            return {"ok": False, "error": error, "imported": [], "skipped": [], "state": _safe_state(ctx, p)}

        if not os.path.exists(path):
            return no("SimpleDeckyTDP's settings were not found")
        raw = context.read_small(path, SDTDP_MAX_BYTES)
        if raw is None:
            return no(f"SimpleDeckyTDP's settings could not be read (not a file, or more than "
                      f"{SDTDP_MAX_BYTES // 1_000_000} MB)")
        try:
            sd = json.loads(raw.decode("utf-8"))
        except ValueError as e:
            return no(f"SimpleDeckyTDP's settings are not valid JSON: {e}")
        profs = sd.get("tdpProfiles") if isinstance(sd, dict) else None
        if not isinstance(profs, dict):
            return no("SimpleDeckyTDP's settings hold no TDP profiles")
        per_game = sd.get("enableTdpProfiles") is True        # SimpleDeckyTDP's default is off
        adv = sd.get("advanced")
        # its -ac-power profiles run only with the advanced "acPowerProfiles" option and per-game profiles on; the
        # entries stay in the file after that option is turned off
        ac_used = per_game and isinstance(adv, dict) and adv.get("acPowerProfiles") is True
        imported: list[str] = []
        skipped: list[str] = []
        found: dict = {}
        for k in sorted(profs, key=lambda k: (k.split("-")[0] != "default", k)):
            m = _SDTDP_KEY.match(k) if isinstance(k, str) else None
            if not m or not isinstance(profs[k], dict):
                skipped.append(f"{k}: not a profile")
                continue
            key, slot = m.group(1), "ac" if m.group(2) else "main"
            if key != "default" and not per_game:
                skipped.append(f"{k}: per-game profiles were off in SimpleDeckyTDP")
                continue
            if slot == "ac" and not ac_used:
                skipped.append(f"{k}: AC power profiles were off in SimpleDeckyTDP")
                continue
            label = ("Default" if key == "default" else key) + (" (AC)" if slot == "ac" else "")
            found.setdefault(key, {})[slot] = _sdtdp_values(profs[k], label, skipped)
            imported.append(label)
        profiles = copy.deepcopy(p.data["profiles"])
        split = p.data["split_ac"]
        games = sum(1 for k in profiles if k != "default")
        for key, slots in found.items():
            if key != "default" and key not in profiles and games >= MAX_PROFILES:
                skipped.append(f"{key}: more than {MAX_PROFILES} profiles")
                imported = [i for i in imported if i not in (key, f"{key} (AC)")]
                continue
            prev = profiles.get(key)
            main = slots.get("main") or (dict(prev["main"]) if prev else dict(profiles["default"]["main"]))
            profiles[key] = {"name": prev["name"] if prev else None, "main": main, "ac": slots.get("ac")}
            if key == "default":
                profiles[key]["low"] = (prev or {}).get("low")     # SimpleDeckyTDP has no low-battery slot
            if key != "default" and prev is None:
                games += 1
            if "ac" in slots:
                split = True
        old = (p.data["profiles"], p.data["split_ac"])
        p.data["profiles"], p.data["split_ac"] = profiles, split
        err = _save(p)
        if err:
            p.data["profiles"], p.data["split_ac"] = old
            return no(err)
        if _may_write(ctx, p):
            _apply(ctx, p)
        return {"ok": True, "error": None, "imported": imported, "skipped": skipped, "state": _safe_state(ctx, p)}
