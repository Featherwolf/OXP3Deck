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


def perf(ctx, max=100, min=9) -> None:
    base = ctx.sys_path("/sys/devices/system/cpu/intel_pstate")
    put(os.path.join(base, "max_perf_pct"), max)
    put(os.path.join(base, "min_perf_pct"), min)


def perf_path(ctx, which="max") -> str:
    return ctx.sys_path(f"/sys/devices/system/cpu/intel_pstate/{which}_perf_pct")


def _cpulist(text: str) -> list[int]:
    out = []
    for part in text.split(","):
        lo, _, hi = part.partition("-")
        out += list(range(int(lo), int(hi or lo) + 1))
    return out


def types(ctx, p="0-3", atom="4-11", no_l3=(8, 9, 10, 11), max_khz=None, min_khz=400000, policies=None,
          base_khz=None) -> None:
    """A hybrid CPU: P cores `p`, atom cores `atom` (LP-E: those in `no_l3`, without cache/index3), one policy per
    CPU (policyN for cpuN, as intel_pstate does). max_khz: {type: kHz} (cpuinfo_max_freq = scaling_max_freq);
    base_khz: {type: kHz} (base_frequency, the non-turbo maximum Writer clamps scaling_max_freq to with no_turbo=1)."""
    max_khz = {"p": 5100000, "e": 3800000, "lpe": 2500000, **(max_khz or {})}
    base_khz = {"p": 2000000, "e": 1800000, "lpe": 1200000, **(base_khz or {})}
    base = ctx.sys_path("/sys/devices")
    if p is not None:
        put(os.path.join(base, "cpu_core", "cpus"), p)
    if atom is not None:
        put(os.path.join(base, "cpu_atom", "cpus"), atom)
    cores = set(_cpulist(p)) if p else set()
    atoms = set(_cpulist(atom)) if atom else set()
    n = policies if policies is not None else len(cores | atoms)
    for i in range(n):
        kind = "p" if i in cores or i not in atoms else ("lpe" if i in no_l3 else "e")
        if not (i in atoms and i in no_l3):
            os.makedirs(os.path.join(base, "system", "cpu", f"cpu{i}", "cache", "index3"), exist_ok=True)
        pol = os.path.join(base, "system", "cpu", "cpufreq", f"policy{i}")
        put(os.path.join(pol, "affected_cpus"), i)
        put(os.path.join(pol, "cpuinfo_max_freq"), max_khz[kind])
        put(os.path.join(pol, "base_frequency"), base_khz[kind])
        put(os.path.join(pol, "cpuinfo_min_freq"), 400000)
        put(os.path.join(pol, "scaling_max_freq"), max_khz[kind])
        put(os.path.join(pol, "scaling_min_freq"), min_khz)


def cap_path(ctx, policy="policy0") -> str:
    return ctx.sys_path(f"/sys/devices/system/cpu/cpufreq/{policy}/scaling_max_freq")


def soc(ctx, balance="03", offset="00", profile="balanced", name="SoC Power Slider", dev="platform-profile-0",
        params=True) -> str:
    """The SoC slider's module parameters and its platform-profile device; returns the device folder."""
    if params:
        base = ctx.sys_path("/sys/module/processor_thermal_soc_slider/parameters")
        put(os.path.join(base, "slider_balance"), balance)
        put(os.path.join(base, "slider_offset"), offset)
    d = ctx.sys_path(f"/sys/class/platform-profile/{dev}")
    put(os.path.join(d, "name"), name)
    put(os.path.join(d, "profile"), profile)
    put(os.path.join(d, "choices"), "low-power balanced performance")
    return d


def soc_param(ctx, which="balance") -> str:
    return ctx.sys_path(f"/sys/module/processor_thermal_soc_slider/parameters/slider_{which}")


def gpu_profile(ctx, value="base", card="card1", gt="gt0") -> str:
    path = ctx.sys_path(f"/sys/class/drm/{card}/device/tile0/{gt}/freq0/power_profile")
    put(path, "[base]    power_saving" if value == "base" else "base    [power_saving]" if value == "power_saving"
        else value)
    return path


def energy(ctx, uj, max_uj=262143328850, zone="intel-rapl:0") -> None:
    base = ctx.sys_path(f"/sys/class/powercap/{zone}")
    put(os.path.join(base, "energy_uj"), int(uj))
    put(os.path.join(base, "max_energy_range_uj"), int(max_uj))


def hwmon(ctx, n: int, name: str, files: dict) -> str:
    base = ctx.sys_path(f"/sys/class/hwmon/hwmon{n}")
    put(os.path.join(base, "name"), name)
    for k, v in files.items():
        put(os.path.join(base, k), v)
    return base


def coretemp(ctx, milli=62000, label="Package id 0", n=3) -> str:
    return hwmon(ctx, n, "coretemp", {"temp1_input": milli, "temp1_label": label, "temp2_input": 50000,
                                      "temp2_label": "Core 0"})


def gtidle(ctx, ms, card="card1", gt="gt0") -> None:
    put(ctx.sys_path(f"/sys/class/drm/{card}/device/tile0/{gt}/gtidle/idle_residency_ms"), int(ms))


def throttle(ctx, ms) -> None:
    put(ctx.sys_path("/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_total_time_ms"), int(ms))


def oxp_ec_fan(ctx, rpm, n=5) -> str:
    return hwmon(ctx, n, "oxp_ec", {"fan1_input": rpm, "pwm1_enable": 2, "pwm1": 0})


class Writer:
    """powerhw._write's stand-in: records (path, text), then writes the file. fail[path-suffix] = errno (EACCES gives
    PermissionError) or a list of them used one per call; ignore: suffixes whose writes are dropped.

    Models intel_pstate's turbo clamp (kernel 7.2 intel_pstate_verify_cpu_policy): with no_turbo=1 a policy's
    scaling_max_freq reads min(the request, base_frequency); the request is kept and comes back with turbo on.
    Only for policies that have a base_frequency file."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.fail: dict = {}
        self.ignore: set = set()
        self.req: dict[str, int] = {}     # policy folder -> the last scaling_max_freq asked for

    def _clamp(self, pol: str) -> None:
        base = os.path.join(pol, "base_frequency")
        if not os.path.isfile(base):
            return
        nt = os.path.join(os.path.dirname(os.path.dirname(pol)), "intel_pstate", "no_turbo")
        turbo_off = os.path.isfile(nt) and get(nt) == "1"
        req = self.req.get(pol)
        if req is None:
            req = int(get(os.path.join(pol, "cpuinfo_max_freq")))
        hi = int(get(base)) if turbo_off else int(get(os.path.join(pol, "cpuinfo_max_freq")))
        with open(os.path.join(pol, "scaling_max_freq"), "w") as f:
            f.write(f"{min(req, hi)}\n")

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
        if path.endswith("/power_profile") and text in ("base", "power_saving"):   # shown as the xe driver does
            text = "[base]    power_saving" if text == "base" else "base    [power_saving]"
        with open(path, "w") as f:
            f.write(text + "\n")
        if path.endswith("/scaling_max_freq"):
            pol = os.path.dirname(path)
            self.req[pol] = int(text)
            self._clamp(pol)
        elif path.endswith("intel_pstate/no_turbo"):
            folder = os.path.join(os.path.dirname(os.path.dirname(path)), "cpufreq")
            for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
                if name.startswith("policy"):
                    self._clamp(os.path.join(folder, name))

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
            elif p.endswith("scaling_max_freq"):
                out.append(os.path.basename(os.path.dirname(p)) + "/cap")
            elif "/platform-profile/" in p:
                out.append("profile")
            else:
                out.append(os.path.basename(p))
        return out


class Systemctl:
    """sysexec.run's stand-in for systemctl: a table of units {name: [load, unit_file_state, active]} that
    list-units and show answer from, and that disable / stop / enable / start change. rc[action] = (rc, stderr)
    fails that action; restart: units that come back (active) right after a stop (a D-Bus activation)."""

    def __init__(self, units: dict | None = None):
        self.units = {k: list(v) for k, v in (units or {}).items()}
        self.calls: list[list[str]] = []
        self.rc: dict = {}
        self.restart: set = set()
        self.listing_rc = 0

    def actions(self) -> list[list[str]]:
        """The calls that change something (not list-units, not show)."""
        return [c for c in self.calls if "list-units" not in c and "show" not in c]

    def __call__(self, argv, **kw):
        from oxp3deck import sysexec
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        self.kw = kw
        if "list-units" in argv:
            if self.listing_rc:
                return sysexec.Result(self.listing_rc, "", "Failed to connect to bus")
            lines = [f"{u:<40} {v[0]:<9} {'active' if v[2] else 'inactive':<8} {'running' if v[2] else 'dead'}  x"
                     for u, v in sorted(self.units.items())]
            return sysexec.Result(0, "\n".join(lines) + "\n", "")
        sep = argv.index("--")
        names = argv[sep + 1:]
        if "show" in argv:
            u = self.units.get(names[0], ["not-found", "", False])
            return sysexec.Result(0, f"LoadState={u[0]}\nUnitFileState={u[1]}\n"
                                     f"ActiveState={'active' if u[2] else 'inactive'}\n", "")
        action = argv[sep - 1]
        if action in self.rc:
            rc, err = self.rc[action]
            return sysexec.Result(rc, "", err)
        for n in names:
            u = self.units[n]
            if action == "disable" and u[1] == "enabled":
                u[1] = "disabled"
            elif action == "enable" and u[1] == "disabled":
                u[1] = "enabled"
            elif action == "stop":
                u[2] = n in self.restart
            elif action == "start":
                u[2] = True
        return sysexec.Result(0, "", "")
