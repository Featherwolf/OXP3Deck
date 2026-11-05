"""The power sysfs files: RAPL power limits (intel-rapl and intel-rapl-mmio), the xe GPU's clock range and power
profile, the CPU's energy-performance preference, turbo, speed cap and floor (max/min_perf_pct), per-policy
scaling_max_freq, and the SoC power slider. sysfs only: no settings, no policy (power.py has those). Values in µW and
MHz. See DESIGN.md "Power (TDP, GPU, CPU)".

Every path goes through ctx.sys_path(); every read through _read() and every write through _write() (tests patch
both). Nothing here raises for an expected failure: a missing file reads as None, a refused write is a `failed`
item in apply()'s answer. No glob (Decky 3.2's Python lacks it): os.scandir only.
"""
from __future__ import annotations

import errno
import logging
import os
import re
import time

log = logging.getLogger("oxp3deck")

WRITE_TIMEOUT_RETRIES = 3          # EAGAIN from xe (a GT reset or resume): 3 tries, 0.3 s apart
RETRY_DELAY_S = 0.3
RAPL_TOLERANCE_UW = 250_000
GPU_TOLERANCE_MHZ = 25
EPP_CHOICES = ("performance", "balance_performance", "balance_power", "power")   # the order shown
MAX_CONSTRAINTS = 6

POWERCAP = "/sys/class/powercap"
DRM = "/sys/class/drm"
CPUFREQ = "/sys/devices/system/cpu/cpufreq"
PSTATE = "/sys/devices/system/cpu/intel_pstate"
POWER_SUPPLY = "/sys/class/power_supply"
SUSPEND_SUCCESS = "/sys/power/suspend_stats/success"
CPU_DEVICES = "/sys/devices"                       # cpu_core/cpus, cpu_atom/cpus (hybrid CPUs)
CPU_SYS = "/sys/devices/system/cpu"
SOC_PARAMS = "/sys/module/processor_thermal_soc_slider/parameters"
PLATFORM_PROFILE = "/sys/class/platform-profile"
SOC_PROFILE_NAME = "SoC Power Slider"
CAP_TOLERANCE_KHZ = 100_000        # HWP rounds scaling_max_freq to its ratio steps
GPU_PROFILES = ("base", "power_saving")
CORE_TYPES = ("p", "e", "lpe")

_ZONE = re.compile(r"^intel-rapl(-mmio)?:\d+$")
_CARD = re.compile(r"^card(\d+)$")
_GT = re.compile(r"^gt(\d+)$")
_POLICY = re.compile(r"^policy(\d+)$")
_PROFILE_DEV = re.compile(r"^platform-profile-\d+$")
_CONSTRAINT = {"long_term": "pl1", "short_term": "pl2", "peak_power": "pl4"}

_sleep = time.sleep   # patched in tests


def _read(path: str) -> str | None:
    """The single reader: a sysfs file's text, stripped; None on any OSError."""
    try:
        with open(path, "rb") as f:
            return f.read(65536).decode("utf-8", errors="replace").strip()
    except OSError:
        return None


def _write(path: str, text: str) -> None:
    """The single writer: one write of text + newline, never through a symlink. Raises OSError."""
    fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.write(fd, (text + "\n").encode())
    finally:
        os.close(fd)


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
            return [e.name for e in it]
    except OSError:
        return []


def _num(name: str, pattern: re.Pattern) -> int:
    m = pattern.match(name)
    return int(m.group(1)) if m else 1 << 30


# ---- discovery ---------------------------------------------------------------------------------------------------

def discover(ctx) -> dict:
    """What there is to control (DESIGN.md `Hw`). Cheap: never reads the GPU's min/max/act/cur (they wake it)."""
    problems: list[str] = []
    rapl = _discover_rapl(ctx)
    if not rapl:
        problems.append("no RAPL power limits found (the intel_rapl_msr and processor_thermal_rapl modules are not "
                        "loaded?)")
    gpu = _discover_gpu(ctx, problems)
    cpu = _discover_cpu(ctx)
    if cpu is None:
        problems.append("no CPU frequency policies found: EPP and turbo cannot be set")
    return {"rapl": rapl, "gpu": gpu, "cpu": cpu, "soc": _discover_soc(ctx), "ac_supply": _ac_supply(ctx),
            "problems": problems}


def _discover_rapl(ctx) -> list[dict]:
    base = ctx.sys_path(POWERCAP)
    zones = []
    for zid in sorted(_entries(base)):
        if not _ZONE.match(zid):
            continue
        path = os.path.join(base, zid)
        name = _read(os.path.join(path, "name"))
        if not name or not name.startswith("package-"):
            continue
        found: dict = {}
        for n in range(MAX_CONSTRAINTS):
            cname = _read(os.path.join(path, f"constraint_{n}_name"))
            key = _CONSTRAINT.get(cname or "")
            if key is None or key in found:
                continue
            if key == "pl4":
                found[key] = {"n": n}
            else:
                found[key] = {"n": n, "max_uw": _int(_read(os.path.join(path, f"constraint_{n}_max_power_uw")))}
        if "pl1" not in found:
            continue
        zones.append({"id": zid, "iface": "mmio" if zid.startswith("intel-rapl-mmio") else "msr", "path": path,
                      "name": name, "pl1": found["pl1"], "pl2": found.get("pl2"), "pl4": found.get("pl4")})
    return zones


def _discover_gpu(ctx, problems: list[str]) -> dict | None:
    base = ctx.sys_path(DRM)
    other = None
    for card in sorted(_entries(base), key=lambda n: _num(n, _CARD)):
        if not _CARD.match(card):
            continue
        dev = os.path.join(base, card, "device")
        if (_read(os.path.join(dev, "vendor")) or "").lower() != "0x8086":
            continue
        try:
            driver = os.path.basename(os.path.realpath(os.path.join(dev, "driver")))
        except OSError:
            driver = ""
        if driver != "xe":
            other = other or (card, driver or "no driver")
            continue
        tile = os.path.join(dev, "tile0")
        gts = sorted((g for g in _entries(tile) if _GT.match(g) and os.path.isdir(os.path.join(tile, g, "freq0"))),
                     key=lambda g: _num(g, _GT))
        if not gts:
            problems.append(f"the xe GPU ({card}) shows no GT frequency controls")
            return None
        names = {g: _read(os.path.join(tile, g, "gtidle", "name")) or "" for g in gts}
        render = next((g for g in gts if names[g].endswith("-rc")), None)
        if render is None:
            render = next((g for g in gts if not names[g].endswith("-mc")), None)
        media = next((g for g in gts if names[g].endswith("-mc")), None)
        if render is None:
            problems.append(f"the xe GPU ({card}) has no render GT")
            return None
        path = os.path.join(tile, render, "freq0")
        rpn, rpe, rp0 = (_int(_read(os.path.join(path, f))) for f in ("rpn_freq", "rpe_freq", "rp0_freq"))
        if rpn is None or rp0 is None or rpn > rp0:
            problems.append(f"cannot read the GPU's clock range ({card} {render})")
            return None
        return {"card": card, "path": path, "gt": render, "media_gt": media, "rpn": rpn, "rpe": rpe, "rp0": rp0,
                "power_profile": os.path.isfile(os.path.join(path, "power_profile"))}
    if other is not None:
        problems.append(f"GPU clocks need the xe driver ({other[0]} uses {other[1]})")
    else:
        problems.append("no Intel GPU found: GPU clocks cannot be set")
    return None


def _discover_cpu(ctx) -> dict | None:
    pstate = _read(ctx.sys_path(PSTATE + "/status"))
    base = ctx.sys_path(CPUFREQ)
    policies = sorted((p for p in _entries(base) if _POLICY.match(p)), key=lambda p: _num(p, _POLICY))
    turbo = _read(ctx.sys_path(PSTATE + "/no_turbo")) is not None
    if not policies and not turbo:
        return None
    p0 = os.path.join(base, policies[0]) if policies else None
    epp = p0 is not None and _read(os.path.join(p0, "energy_performance_preference")) is not None
    avail = (_read(os.path.join(p0, "energy_performance_available_preferences")) or "").split() if epp else []
    perf = all(_read(ctx.sys_path(f"{PSTATE}/{f}")) is not None for f in ("max_perf_pct", "min_perf_pct"))
    types, type_range = _core_types(ctx, base, policies)
    return {"pstate": pstate if pstate in ("active", "passive", "off") else None,
            "governor": _read(os.path.join(p0, "scaling_governor")) if p0 else None,
            "policies": policies, "epp": epp, "epp_choices": [c for c in EPP_CHOICES if c in avail],
            "turbo": turbo, "perf_pct": perf, "types": types, "type_range": type_range}


def _cpulist(text: str | None) -> set[int]:
    """A kernel cpulist ("0-3,8") as a set; anything unreadable as empty."""
    out: set[int] = set()
    for part in (text or "").replace("\n", ",").split(","):
        part = part.strip()
        if not part:
            continue
        lo, sep, hi = part.partition("-")
        try:
            a, b = int(lo), int(hi) if sep else int(lo)
        except ValueError:
            return set()
        if b < a or b - a > 4096:
            return set()
        out.update(range(a, b + 1))
    return out


def _core_types(ctx, base: str, policies: list[str]) -> tuple[dict, dict]:
    """({type: [policy, ...]}, {type: {min_mhz, max_mhz}}): a policy's type is that of the first CPU in its
    affected_cpus: P in cpu_core/cpus, LP-E in cpu_atom/cpus without an L3 cache (cache/index3), E otherwise. Not
    hybrid (neither list): every policy is P. Groups with no policy are left out."""
    core = _cpulist(_read(ctx.sys_path(CPU_DEVICES + "/cpu_core/cpus")))
    atom = _cpulist(_read(ctx.sys_path(CPU_DEVICES + "/cpu_atom/cpus")))
    types: dict = {}
    ranges: dict = {}
    for pol in policies:
        path = os.path.join(base, pol)
        cpus = (_read(os.path.join(path, "affected_cpus")) or "").split()
        first = int(cpus[0]) if cpus and cpus[0].isdigit() else None
        kind = "p"
        if first is not None and first not in core and first in atom:
            l3 = ctx.sys_path(f"{CPU_SYS}/cpu{first}/cache/index3")
            kind = "e" if os.path.isdir(l3) else "lpe"
        types.setdefault(kind, []).append(pol)
        lo = _int(_read(os.path.join(path, "cpuinfo_min_freq")))
        hi = _int(_read(os.path.join(path, "cpuinfo_max_freq")))
        r = ranges.setdefault(kind, {"min_mhz": None, "max_mhz": None})
        if lo is not None:
            r["min_mhz"] = lo // 1000 if r["min_mhz"] is None else min(r["min_mhz"], lo // 1000)
        if hi is not None:
            r["max_mhz"] = hi // 1000 if r["max_mhz"] is None else max(r["max_mhz"], hi // 1000)
    types = {k: types[k] for k in CORE_TYPES if k in types}
    ranges = {k: ranges[k] for k in types if ranges[k]["min_mhz"] is not None and ranges[k]["max_mhz"] is not None}
    return types, ranges


def _discover_soc(ctx) -> dict | None:
    """The SoC power slider: both module parameters, and the platform-profile device named "SoC Power Slider"
    (found by name, never by index)."""
    params = ctx.sys_path(SOC_PARAMS)
    if not all(os.path.isfile(os.path.join(params, f)) for f in ("slider_balance", "slider_offset")):
        return None
    base = ctx.sys_path(PLATFORM_PROFILE)
    for dev in sorted(_entries(base)):
        if _PROFILE_DEV.match(dev) and _read(os.path.join(base, dev, "name")) == SOC_PROFILE_NAME:
            return {"params": params, "profile": os.path.join(base, dev)}
    return None


def _supplies(ctx) -> list[tuple[str, str]]:
    base = ctx.sys_path(POWER_SUPPLY)
    return [(n, _read(os.path.join(base, n, "type")) or "") for n in sorted(_entries(base))]


def _ac_supply(ctx) -> str | None:
    sup = _supplies(ctx)
    for kind in ("Mains", "USB"):
        for name, t in sup:
            if t == kind:
                return name
    return None


def ac_online(ctx) -> bool | None:
    """On AC power: a "Mains" supply's online; with none, a "USB" supply's; with none, any BAT*'s status
    Charging/Full; nothing at all: None."""
    base = ctx.sys_path(POWER_SUPPLY)
    sup = _supplies(ctx)
    for kind in ("Mains", "USB"):
        vals = [_int(_read(os.path.join(base, n, "online"))) for n, t in sup if t == kind]
        vals = [v for v in vals if v is not None]
        if vals:
            return any(v == 1 for v in vals)
    states = [_read(os.path.join(base, n, "status")) for n, t in sup if n.startswith("BAT")]
    states = [s for s in states if s]
    if states:
        return any(s in ("Charging", "Full") for s in states)
    return None


def suspend_count(ctx) -> int | None:
    return _int(_read(ctx.sys_path(SUSPEND_SUCCESS)))


# ---- reading -----------------------------------------------------------------------------------------------------

def _limit_path(zone: dict, which: str) -> str | None:
    c = zone.get(which)
    return os.path.join(zone["path"], f"constraint_{c['n']}_power_limit_uw") if c else None


def _gpu_file(hw: dict, name: str) -> str:
    return os.path.join(hw["gpu"]["path"], name)


def _epp_path(ctx, policy: str) -> str:
    return os.path.join(ctx.sys_path(CPUFREQ), policy, "energy_performance_preference")


def _no_turbo_path(ctx) -> str:
    return ctx.sys_path(PSTATE + "/no_turbo")


def _perf_path(ctx, which: str) -> str:
    return ctx.sys_path(f"{PSTATE}/{which}_perf_pct")


def _policy_file(ctx, policy: str, name: str) -> str:
    return os.path.join(ctx.sys_path(CPUFREQ), policy, name)


def _hex(text: str | None) -> int | None:
    if not text:
        return None
    try:
        return int(text.split()[0], 16)
    except ValueError:
        return None


def _bracketed(text: str | None) -> str | None:
    """The bracketed word of a choice file ("[base]    power_saving" → "base"); None without one."""
    m = re.search(r"\[([^\]\s]+)\]", text or "")
    return m.group(1) if m else None


def _read_soc(hw: dict) -> dict | None:
    soc = hw.get("soc")
    if not soc:
        return None
    balance = _hex(_read(os.path.join(soc["params"], "slider_balance")))
    offset = _hex(_read(os.path.join(soc["params"], "slider_offset")))
    if balance is None or offset is None:
        return None
    return {"balance": balance, "offset": offset, "profile": _read(os.path.join(soc["profile"], "profile")),
            "choices": (_read(os.path.join(soc["profile"], "choices")) or "").split()}


def read(ctx, hw: dict, gpu: bool) -> dict:
    """The values now (DESIGN.md `Reading`). gpu=False leaves out the files that wake the GPU."""
    rapl = {}
    for z in hw.get("rapl") or []:
        vals = {}
        for k in ("pl1", "pl2", "pl4"):
            path = _limit_path(z, k)
            vals[f"{k}_uw"] = _int(_read(path)) if path else None
        rapl[z["id"]] = vals
    g = None
    if hw.get("gpu"):
        g = {"min": None, "max": None, "act": None, "cur": None, "reasons": [], "profile": None}
        if hw["gpu"].get("power_profile"):   # its show prints a cached value: it does not wake the GPU
            prof = _bracketed(_read(_gpu_file(hw, "power_profile")))
            g["profile"] = prof if prof in GPU_PROFILES else None
        if gpu:
            for k in ("min", "max", "act", "cur"):
                g[k] = _int(_read(_gpu_file(hw, f"{k}_freq")))
            text = _read(_gpu_file(hw, "throttle/reasons")) or ""
            g["reasons"] = [r[len("reason_"):] if r.startswith("reason_") else r
                            for r in re.split(r"[\s,]+", text) if r and r != "none"]
    cpu = hw.get("cpu") or {}
    epp = None
    if cpu.get("epp"):
        epp = {p: _read(_epp_path(ctx, p)) for p in cpu.get("policies") or []}
    turbo = None
    if cpu.get("turbo"):
        nt = _int(_read(_no_turbo_path(ctx)))
        turbo = None if nt is None else nt == 0
    governor = None
    if cpu.get("policies"):
        governor = _read(os.path.join(ctx.sys_path(CPUFREQ), cpu["policies"][0], "scaling_governor"))
    perf = None
    if cpu.get("perf_pct"):
        mx, mn = _int(_read(_perf_path(ctx, "max"))), _int(_read(_perf_path(ctx, "min")))
        perf = {"max": mx, "min": mn} if mx is not None and mn is not None else None
    caps = None
    if cpu.get("policies"):
        caps = {p: _int(_read(_policy_file(ctx, p, "scaling_max_freq"))) for p in cpu["policies"]}
    return {"rapl": rapl, "gpu": g, "epp": epp, "turbo": turbo, "governor": governor, "ac": ac_online(ctx),
            "perf": perf, "caps": caps, "soc": _read_soc(hw)}


# ---- applying ----------------------------------------------------------------------------------------------------

def _w(uw) -> str:
    return "unreadable" if uw is None else f"{uw / 1e6:g} W"


def _strerror(e: OSError) -> str:
    return e.strerror or str(e) or type(e).__name__


def _close(a, b, tol) -> bool:
    return a is not None and b is not None and abs(a - b) <= tol


def apply(ctx, hw: dict, target: dict, locked: list[str]) -> dict:
    """Write `target` (DESIGN.md `Target`; a missing key: not touched), skipping what already reads the same and the
    ids in `locked`, then read everything back. Answers `ApplyResult`; never rolls back."""
    locked = set(locked or [])
    before = read(ctx, hw, gpu="gpu" in target)
    written: list[str] = []
    failed: list[dict] = []
    checks: list[tuple] = []   # (id, kind, wanted, reader)

    def fail(item_id, error, is_locked=False, transient=False):
        failed.append({"id": item_id, "error": error, "locked": is_locked, "transient": transient})

    # 1. RAPL: MMIO zones first (firmware rewrites them), then MSR; PL1 <= PL2 at every step
    zones = sorted(hw.get("rapl") or [], key=lambda z: 0 if z["iface"] == "mmio" else 1)
    for z in zones:
        t = (target.get("rapl") or {}).get(z["id"])
        if not t:
            continue
        cur = before["rapl"].get(z["id"], {})
        pl1, pl2 = t.get("pl1_uw"), t.get("pl2_uw")
        floor = pl1 if pl1 is not None else cur.get("pl1_uw")
        if pl2 is not None and floor is not None and pl2 < floor:
            pl2 = floor
        order = ["pl1", "pl2"]
        if pl1 is not None and cur.get("pl1_uw") is not None and pl1 > cur["pl1_uw"]:
            order = ["pl2", "pl1"]
        for k in order:
            want = pl1 if k == "pl1" else pl2
            item = f"{z['id']}/{k}"
            path = _limit_path(z, k)
            if want is None or path is None or item in locked:
                continue
            want = int(want)
            if not _close(cur.get(f"{k}_uw"), want, RAPL_TOLERANCE_UW):
                try:
                    _write(path, str(want))
                    written.append(item)
                except PermissionError:
                    fail(item, "locked by firmware", True)
                    continue
                except OSError as e:
                    fail(item, _strerror(e))
                    continue
            checks.append((item, "rapl", want, (z["id"], f"{k}_uw")))

    # 2. GPU clock range of the render GT
    tg = target.get("gpu")
    if tg and hw.get("gpu"):
        g = hw["gpu"]
        cur = before["gpu"] or {}
        lo, hi = tg.get("min"), tg.get("max")
        if lo is not None and hi is not None and lo > hi:
            lo = hi
        order = ["min", "max"]
        if lo is not None and cur.get("min") is not None and lo > cur["min"]:
            order = ["max", "min"]
        for k in order:
            want = lo if k == "min" else hi
            if want is None:
                continue
            want = int(want)
            item = f"gpu/{k}"
            if not _close(cur.get(k), want, GPU_TOLERANCE_MHZ):
                err = _write_gpu(_gpu_file(hw, f"{k}_freq"), want, g)
                if err:
                    fail(item, err)
                    continue
                written.append(item)
            checks.append((item, "gpu", want, k))
    elif tg:
        fail("gpu", "no xe GPU clock controls")

    # 3. EPP
    cpu = hw.get("cpu") or {}
    te = target.get("epp")
    if te is not None:
        _apply_epp(ctx, cpu, te, before, written, fail, checks)

    # 4. turbo
    tt = target.get("turbo")
    if tt is not None:
        if not cpu.get("turbo"):
            fail("turbo", "this CPU has no turbo switch (intel_pstate/no_turbo)")
        else:
            if before["turbo"] != bool(tt):
                try:
                    _write(_no_turbo_path(ctx), "0" if tt else "1")
                    written.append("turbo")
                except PermissionError:
                    fail("turbo", "firmware has turned turbo off")
                except OSError as e:
                    fail("turbo", _strerror(e))
            if not any(f["id"] == "turbo" for f in failed):
                checks.append(("turbo", "turbo", bool(tt), None))

    # 5. CPU speed cap and floor, 6. per-policy caps, 7. SoC slider, 8. GPU power profile
    _apply_perf(ctx, cpu, target.get("perf"), before, written, fail, checks)
    _apply_caps(ctx, cpu, target.get("caps"), before, written, fail, checks)
    _apply_soc(hw, target.get("soc"), before, written, fail, checks)
    _apply_gpu_profile(hw, target.get("gpu_profile"), before, written, fail, checks)

    # 9. read back
    after = read(ctx, hw, gpu="gpu" in target)
    for item, kind, want, where in checks:
        if kind == "rapl":
            got = after["rapl"].get(where[0], {}).get(where[1])
            ok, shown = _close(got, want, RAPL_TOLERANCE_UW), _w(got)
        elif kind == "gpu":
            got = (after["gpu"] or {}).get(where)
            ok, shown = _close(got, want, GPU_TOLERANCE_MHZ), "unreadable" if got is None else f"{got} MHz"
        elif kind == "epp":
            got = (after["epp"] or {}).get(where)
            ok, shown = got == want, got or "unreadable"
        elif kind == "perf":
            got = (after["perf"] or {}).get(where)
            ok, shown = got == want, "unreadable" if got is None else f"{got} %"
        elif kind == "cap":
            got = (after["caps"] or {}).get(where)
            ok, shown = _close(got, want, CAP_TOLERANCE_KHZ), "unreadable" if got is None else f"{got // 1000} MHz"
        elif kind == "soc":
            got = (after["soc"] or {}).get(where)
            ok, shown = got == want, "unreadable" if got is None else f"{got:02x}" if isinstance(got, int) else got
        elif kind == "gpu_profile":
            got = (after["gpu"] or {}).get("profile")
            ok, shown = got == want, got or "unreadable"
        else:
            got = after["turbo"]
            ok, shown = got == want, {True: "on", False: "off", None: "unreadable"}[got]
        if not ok:
            # the GPU's power profile: its store resumes the GPU (7.2 power_profile_store takes the runtime-PM guard),
            # so a differing read-back means a GuC error or a GT reset in between: tried again later ("Polling rate")
            fail(item, f"did not take: reads {shown}", transient=kind == "gpu_profile")
            if item in written:
                written.remove(item)
    # PL4 is never written, but one left below the boost by another tool (Handheld Daemon scales it with the TDP;
    # SimpleDeckyTDP's constraint_* write sets it on MSR-only machines) silently caps PL1 and PL2: say so
    for z in zones:
        t = (target.get("rapl") or {}).get(z["id"])
        r = after["rapl"].get(z["id"], {})
        pl4, pl2 = r.get("pl4_uw"), r.get("pl2_uw")
        if t and pl4 is not None and pl4 > 0 and pl2 is not None and pl4 < pl2 - RAPL_TOLERANCE_UW:
            fail(f"{z['id']}/pl4", f"peak limit {_w(pl4)} is below boost (set by another tool); reboot to restore")
    errors = [f"{f['id']}: {f['error']}" for f in failed]
    return {"ok": not failed, "error": "; ".join(errors[:3]) if errors else None, "written": written,
            "failed": failed, "reading": after}


def _write_retry(path: str, text: str) -> OSError | None:
    """None when written, else the last error. EAGAIN (an xe GT reset or resume) is tried WRITE_TIMEOUT_RETRIES
    times, RETRY_DELAY_S apart."""
    for attempt in range(WRITE_TIMEOUT_RETRIES):
        try:
            _write(path, text)
            return None
        except OSError as e:
            if e.errno == errno.EAGAIN and attempt + 1 < WRITE_TIMEOUT_RETRIES:
                _sleep(RETRY_DELAY_S)
                continue
            return e
    return OSError(errno.EAGAIN, "busy")   # not reached


def _write_gpu(path: str, mhz: int, g: dict) -> str | None:
    """None when written; else why not."""
    e = _write_retry(path, str(mhz))
    if e is None:
        return None
    if e.errno == errno.EINVAL:
        return f"{mhz} MHz is outside {g['rpn']}..{g['rp0']} MHz"
    if e.errno == errno.EAGAIN:
        return "the GPU is busy (resetting or resuming): try again"
    return _strerror(e)


def _apply_perf(ctx, cpu, tp, before, written, fail, checks) -> None:
    """intel_pstate max_perf_pct / min_perf_pct. The driver clamps the cap to [floor, 100] and the floor to
    [minimum, cap], so a rising cap is written first, else the floor first. Never 0 (the driver reads it as the
    floor)."""
    if tp is None:
        return
    if not cpu.get("perf_pct"):
        fail("cpu/max_pct", "this CPU has no intel_pstate speed cap (max_perf_pct)")
        return
    # Read again now, not `before`: turning turbo off (step 4) makes the driver lower min_perf_pct to
    # max_pstate/turbo_pstate (about 40 % here), so a floor that matched before may not match any more.
    cur = {k: _int(_read(_perf_path(ctx, k))) for k in ("max", "min")}
    mx, mn = tp.get("max"), tp.get("min")
    if mx is not None and mn is not None and mn > mx:
        mn = mx                          # the last guard: power.py keeps min <= max
    order = [("max", mx), ("min", mn)]
    if mx is not None and cur.get("max") is not None and mx < cur["max"]:
        order = [("min", mn), ("max", mx)]
    for k, want in order:
        if want is None:
            continue
        want = int(want)
        item = f"cpu/{k}_pct"
        if not 1 <= want <= 100:
            fail(item, f"{want} % is outside 1..100")
            continue
        if cur.get(k) != want:
            try:
                _write(_perf_path(ctx, k), str(want))
                written.append(item)
            except OSError as e:
                fail(item, _strerror(e))
                continue
        checks.append((item, "perf", want, k))


def _apply_caps(ctx, cpu, tc, before, written, fail, checks) -> None:
    """Each policy's scaling_max_freq (kHz), clamped to [its scaling_min_freq now, cpuinfo_max_freq]."""
    if not tc:
        return
    cur = before.get("caps") or {}
    for pol in cpu.get("policies") or []:
        if pol not in tc or tc[pol] is None:
            continue
        item = f"cpu/cap/{pol}"
        want = int(tc[pol])
        hi = _int(_read(_policy_file(ctx, pol, "cpuinfo_max_freq")))
        lo = _int(_read(_policy_file(ctx, pol, "scaling_min_freq")))
        if hi is not None:
            want = min(want, hi)
        if lo is not None:
            want = max(want, lo)
        if not _close(cur.get(pol), want, CAP_TOLERANCE_KHZ):
            try:
                _write(_policy_file(ctx, pol, "scaling_max_freq"), str(want))
                written.append(item)
            except OSError as e:
                fail(item, f"{want // 1000} MHz refused" if e.errno == errno.EINVAL else _strerror(e))
                continue
        checks.append((item, "cap", want, pol))


def _apply_soc(hw, ts, before, written, fail, checks) -> None:
    """slider_offset, then slider_balance (hex), then the word `balanced` into the SoC Power Slider's profile, only
    when it reads `balanced` now: the slider reaches the firmware only on a profile write, and power-profiles-daemon
    owns the choice of profile. Never another word, never the legacy /sys/firmware/acpi/platform_profile."""
    if not ts:
        return
    soc = hw.get("soc")
    if not soc:
        fail("soc", "no SoC power slider")
        return
    cur = before.get("soc") or {}
    wrote = False
    balance_unchecked = False
    for k, fname in (("offset", "slider_offset"), ("balance", "slider_balance")):
        want = ts.get(k)
        if want is None:
            continue
        want = int(want)
        item = f"soc/{k}"
        if cur.get(k) != want:
            try:
                _write(os.path.join(soc["params"], fname), f"{want:02x}")
                written.append(item)
                wrote = True
                balance_unchecked = balance_unchecked or k == "balance"
            except OSError as e:
                fail(item, ("the slider takes 1..5" if k == "balance" else "the offset takes 0..6")
                     if e.errno == errno.EINVAL else _strerror(e))
                continue
        checks.append((item, "soc", want, k))
    if not wrote:
        return
    profile = os.path.join(soc["profile"], "profile")
    if _read(profile) != "balanced":
        # power-profiles-daemon's next `balanced` picks the values up; slider_balance reads its old value until a
        # profile write, so it cannot be read back now
        if balance_unchecked:
            checks[:] = [c for c in checks if c[0] != "soc/balance"]
        return
    try:
        _write(profile, "balanced")
        written.append("soc/profile")
        checks.append(("soc/profile", "soc", "balanced", "profile"))
    except OSError as e:
        fail("soc/profile", _strerror(e))
        if balance_unchecked:
            checks[:] = [c for c in checks if c[0] != "soc/balance"]


def _apply_gpu_profile(hw, tgp, before, written, fail, checks) -> None:
    """The render GT's freq0/power_profile. The write wakes the GPU (7.2 power_profile_store takes the runtime-PM
    guard; only xe_guc_pc_set_power_profile inside it uses the no-resume one), so it is written only when it differs.
    EAGAIN after the retries or a GuC error is `transient` (tried again later, not shown as an error)."""
    if tgp is None:
        return
    g = hw.get("gpu") or {}
    if not g.get("power_profile"):
        fail("gpu/profile", "this GPU has no power profile setting")
        return
    if tgp not in GPU_PROFILES:
        fail("gpu/profile", f"{tgp!r} is not a GPU power profile")
        return
    if (before.get("gpu") or {}).get("profile") != tgp:
        e = _write_retry(os.path.join(g["path"], "power_profile"), tgp)
        if e is not None:
            fail("gpu/profile", f"the GPU did not take it now ({_strerror(e)}): tried again later", transient=True)
            return
        written.append("gpu/profile")
    checks.append(("gpu/profile", "gpu_profile", tgp, None))


def _raw_epp(v) -> bool:
    return isinstance(v, str) and re.fullmatch(r"\d{1,3}", v) is not None and int(v) <= 255


def _apply_epp(ctx, cpu, te, before, written, fail, checks) -> None:
    if not cpu.get("epp"):
        fail("epp", "this CPU has no energy-performance preference")
        return
    policies = cpu.get("policies") or []
    want = {p: te for p in policies} if isinstance(te, str) else {p: v for p, v in te.items() if p in policies}
    cur = before["epp"] or {}
    todo = {p: v for p, v in want.items() if cur.get(p) != v}
    if todo:
        choices = cpu.get("epp_choices") or []
        # a dict target is the boot snapshot: intel_pstate shows an EPP that matches none of its names as a raw
        # number (0..255), and takes one back
        bad = sorted({v for v in todo.values()
                      if v not in choices and not (isinstance(te, dict) and _raw_epp(v))})
        if bad:
            fail("epp", f"{bad[0]!r} is not offered by this CPU")
            return
        if before.get("governor") == "performance":
            fail("epp", "the CPU governor is performance: EPP cannot change")
            return
    any_written = False
    for p in policies:
        if p not in want:
            continue
        if p in todo:
            try:
                _write(_epp_path(ctx, p), want[p])
                any_written = True
            except OSError as e:
                fail(f"epp/{p}", "busy (EBUSY)" if e.errno == errno.EBUSY else _strerror(e))
                continue
        checks.append((f"epp/{p}", "epp", want[p], p))
    if any_written:
        written.append("epp")
