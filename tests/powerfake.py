"""Fake power sysfs trees under ctx.root (stub_decky.make_ctx) and a recording stand-in for powerhw._write.

rapl(), xe(), cpu(), ac(), suspend(), plugins() lay out what powerhw.discover and read look at; Writer records every
write (and writes the file, as sysfs would) and can fail a path or ignore a write (an MMIO lock).
"""
from __future__ import annotations

import errno
import json
import os

MW = 1_000_000


def put(path: str, text) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(f"{text}\n")


def get(path: str) -> str:
    with open(path) as f:
        return f.read().strip()


def rapl(ctx, zone="intel-rapl:0", pl1=25, pl2=52, pl4=160, order=("long_term", "short_term", "peak_power"),
         base=25, name="package-0", pl2_max=0) -> str:
    path = ctx.sys_path(f"/sys/class/powercap/{zone}")
    put(os.path.join(path, "name"), name)
    put(os.path.join(path, "enabled"), 1)
    vals = {"long_term": (pl1, base, 27983872), "short_term": (pl2, pl2_max, 976), "peak_power": (pl4, 0, None)}
    for n, cname in enumerate(order):
        limit, mx, window = vals[cname]
        put(os.path.join(path, f"constraint_{n}_name"), cname)
        put(os.path.join(path, f"constraint_{n}_power_limit_uw"), int(limit * MW))
        put(os.path.join(path, f"constraint_{n}_max_power_uw"), int(mx * MW))
        if window is not None:
            put(os.path.join(path, f"constraint_{n}_time_window_us"), window)
    return path


def limit(ctx, zone: str, which: str) -> str:
    """The power_limit_uw path of constraint `which` (long_term, short_term, peak_power) of `zone`."""
    path = ctx.sys_path(f"/sys/class/powercap/{zone}")
    for n in range(6):
        p = os.path.join(path, f"constraint_{n}_name")
        if os.path.exists(p) and get(p) == which:
            return os.path.join(path, f"constraint_{n}_power_limit_uw")
    raise KeyError(which)


def watts(ctx, zone: str, which: str) -> float:
    return int(get(limit(ctx, zone, which))) / MW


def set_watts(ctx, zone: str, which: str, w) -> None:
    put(limit(ctx, zone, which), int(w * MW))


def xe(ctx, card="card1", gts=None, rpn=100, rpe=900, rp0=2300, minf=850, maxf=2300, driver="xe",
       vendor="0x8086") -> str:
    """The render GT's freq0 folder."""
    gts = {"gt0": "gt0-rc", "gt1": "gt1-mc"} if gts is None else gts
    dev = ctx.sys_path(f"/sys/class/drm/{card}/device")
    put(os.path.join(dev, "vendor"), vendor)
    drv = ctx.sys_path(f"/sys/bus/pci/drivers/{driver}")
    os.makedirs(drv, exist_ok=True)
    os.symlink(drv, os.path.join(dev, "driver"))
    os.makedirs(ctx.sys_path(f"/sys/class/drm/{card}-eDP-1"), exist_ok=True)
    for gt, idle in gts.items():
        base = os.path.join(dev, "tile0", gt)
        media = idle is not None and idle.endswith("-mc")
        f = os.path.join(base, "freq0")
        put(os.path.join(f, "rpn_freq"), rpn)
        put(os.path.join(f, "rpe_freq"), 500 if media else rpe)
        put(os.path.join(f, "rp0_freq"), 1200 if media else rp0)
        put(os.path.join(f, "min_freq"), 600 if media else minf)
        put(os.path.join(f, "max_freq"), 1200 if media else maxf)
        put(os.path.join(f, "act_freq"), 0 if media else 1450)
        put(os.path.join(f, "cur_freq"), 0 if media else 1500)
        put(os.path.join(f, "throttle", "reasons"), "none")
        if idle is not None:
            put(os.path.join(base, "gtidle", "name"), idle)
    return os.path.join(dev, "tile0", next(g for g, i in gts.items() if not (i or "").endswith("-mc")), "freq0")


def cpu(ctx, policies=14, epp="balance_performance", governor="powersave", status="active", no_turbo=0,
        choices="default performance balance_performance balance_power power") -> None:
    base = ctx.sys_path("/sys/devices/system/cpu")
    if status is not None:
        put(os.path.join(base, "intel_pstate", "status"), status)
    if no_turbo is not None:
        put(os.path.join(base, "intel_pstate", "no_turbo"), no_turbo)
    for i in range(policies):
        p = os.path.join(base, "cpufreq", f"policy{i}")
        put(os.path.join(p, "scaling_governor"), governor)
        if epp is not None:
            put(os.path.join(p, "energy_performance_preference"), epp)
            put(os.path.join(p, "energy_performance_available_preferences"), choices)


def epp_path(ctx, policy="policy0") -> str:
    return ctx.sys_path(f"/sys/devices/system/cpu/cpufreq/{policy}/energy_performance_preference")


def no_turbo_path(ctx) -> str:
    return ctx.sys_path("/sys/devices/system/cpu/intel_pstate/no_turbo")


def ac(ctx, online=True, name="ADP1", kind="Mains") -> None:
    base = ctx.sys_path(f"/sys/class/power_supply/{name}")
    put(os.path.join(base, "type"), kind)
    if online is not None:
        put(os.path.join(base, "online"), 1 if online else 0)


def battery(ctx, status="Discharging", name="BAT0") -> None:
    base = ctx.sys_path(f"/sys/class/power_supply/{name}")
    put(os.path.join(base, "type"), "Battery")
    put(os.path.join(base, "status"), status)


def suspend(ctx, success=0) -> None:
    put(ctx.sys_path("/sys/power/suspend_stats/success"), success)


def boot_id(ctx, value="boot-1") -> None:
    put(ctx.sys_path("/proc/sys/kernel/random/boot_id"), value)


def dmi(ctx, vendor="ONE-NETBOOK", product="ONEXPLAYER 3") -> None:
    put(ctx.sys_path("/sys/class/dmi/id/sys_vendor"), vendor)
    put(ctx.sys_path("/sys/class/dmi/id/product_name"), product)


def homebrew(ctx) -> str:
    return os.path.dirname(os.path.dirname(ctx.settings_dir))


def plugins(ctx, states: dict) -> None:
    """Decky plugins by name: True enabled, False in loader.json's disabled_plugins."""
    brew = homebrew(ctx)
    for name in states:
        put(os.path.join(brew, "plugins", name, "plugin.json"), json.dumps({"name": name, "flags": ["root"]}))
    put(os.path.join(brew, "settings", "loader.json"),
        json.dumps({"disabled_plugins": [n for n, on in states.items() if not on]}))


def oxp3(ctx, msr=True, mmio=True, gpu=True, cpu_=True, on_ac=False):
    """The owner's OXP3 at boot: MSR 25/52/160 W, MMIO 35/52/160 W, xe card1, 14 policies, on battery."""
    dmi(ctx)
    boot_id(ctx)
    if msr:
        rapl(ctx, "intel-rapl:0")
        rapl(ctx, "intel-rapl:1", pl1=0, pl2=0, name="psys")
        rapl(ctx, "intel-rapl:0:0", pl1=0, pl2=0, name="core")
    if mmio:
        rapl(ctx, "intel-rapl-mmio:0", pl1=35)
    if gpu:
        xe(ctx)
    if cpu_:
        cpu(ctx)
    ac(ctx, online=on_ac)
    battery(ctx, "Charging" if on_ac else "Discharging")
    suspend(ctx, 0)


class Writer:
    """powerhw._write's stand-in: records (path, text), then writes the file. fail[path-suffix] = errno (EACCES gives
    PermissionError) or a list of them used one per call; ignore: suffixes whose writes are dropped."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.fail: dict = {}
        self.ignore: set = set()

    def _match(self, table, path):
        for k in table:
            if path.endswith(k):
                return k
        return None

    def __call__(self, path: str, text: str) -> None:
        self.calls.append((path, text))
        k = self._match(self.fail, path)
        if k is not None:
            err = self.fail[k]
            if isinstance(err, list):
                err = err.pop(0) if err else None
            if err is not None:
                if err in (errno.EACCES, errno.EPERM):
                    raise PermissionError(err, os.strerror(err), path)
                raise OSError(err, os.strerror(err), path)
        if self._match(self.ignore, path) is not None:
            return
        if not os.path.isfile(path):
            raise FileNotFoundError(errno.ENOENT, "No such file or directory", path)
        with open(path, "w") as f:
            f.write(text + "\n")

    def paths(self) -> list[str]:
        return [p for p, _ in self.calls]

    def names(self, ctx) -> list[str]:
        """The writes as short names: intel-rapl:0/long_term, gpu/min_freq, policy3/epp, no_turbo."""
        out = []
        for p, _ in self.calls:
            if "/powercap/" in p:
                zone = p.split("/powercap/")[1].split("/")[0]
                n = os.path.basename(p).split("_")[1]
                cname = get(os.path.join(os.path.dirname(p), f"constraint_{n}_name"))
                out.append(f"{zone}/{cname}")
            elif p.endswith(("min_freq", "max_freq")):
                out.append("gpu/" + os.path.basename(p))
            elif p.endswith("energy_performance_preference"):
                out.append(os.path.basename(os.path.dirname(p)) + "/epp")
            else:
                out.append(os.path.basename(p))
        return out
