"""The power sysfs files: RAPL power limits (intel-rapl and intel-rapl-mmio), the xe GPU's clock range, the CPU's
energy-performance preference and turbo. sysfs only: no settings, no policy (power.py has those). Values in µW and
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

_ZONE = re.compile(r"^intel-rapl(-mmio)?:\d+$")
_CARD = re.compile(r"^card(\d+)$")
_GT = re.compile(r"^gt(\d+)$")
_POLICY = re.compile(r"^policy(\d+)$")
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
    return {"rapl": rapl, "gpu": gpu, "cpu": cpu, "ac_supply": _ac_supply(ctx), "problems": problems}


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
        return {"card": card, "path": path, "gt": render, "media_gt": media, "rpn": rpn, "rpe": rpe, "rp0": rp0}
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
    return {"pstate": pstate if pstate in ("active", "passive", "off") else None,
            "governor": _read(os.path.join(p0, "scaling_governor")) if p0 else None,
            "policies": policies, "epp": epp, "epp_choices": [c for c in EPP_CHOICES if c in avail],
            "turbo": turbo}


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
        g = {"min": None, "max": None, "act": None, "cur": None, "reasons": []}
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
    return {"rapl": rapl, "gpu": g, "epp": epp, "turbo": turbo, "governor": governor, "ac": ac_online(ctx)}


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

    def fail(item_id, error, is_locked=False):
        failed.append({"id": item_id, "error": error, "locked": is_locked})

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

    # 5. read back
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
        else:
            got = after["turbo"]
            ok, shown = got == want, {True: "on", False: "off", None: "unreadable"}[got]
        if not ok:
            fail(item, f"did not take: reads {shown}")
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


def _write_gpu(path: str, mhz: int, g: dict) -> str | None:
    """None when written; else why not. EAGAIN (a GT reset or resume) is tried WRITE_TIMEOUT_RETRIES times."""
    for attempt in range(WRITE_TIMEOUT_RETRIES):
        try:
            _write(path, str(mhz))
            return None
        except OSError as e:
            if e.errno == errno.EAGAIN and attempt + 1 < WRITE_TIMEOUT_RETRIES:
                _sleep(RETRY_DELAY_S)
                continue
            if e.errno == errno.EINVAL:
                return f"{mhz} MHz is outside {g['rpn']}..{g['rp0']} MHz"
            if e.errno == errno.EAGAIN:
                return "the GPU is busy (resetting or resuming): try again"
            return _strerror(e)
    return "the GPU is busy"   # not reached


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
