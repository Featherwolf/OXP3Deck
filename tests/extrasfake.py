"""Fake sysfs trees and a fake sysexec.run for test_extras.py.

board(), oxp_ec(), coretemp(), battery(), sched_ext(), lpmd_unit() lay out what extras.py looks at under ctx.root
(stub_decky.make_ctx). Bus answers busctl (org.scx.Loader properties and methods, intel_lpmd's methods) and
systemctl is-active from its tables and records every argv; the scheduler follows SwitchScheduler like the loader.
"""
from __future__ import annotations

import json
import os

from oxp3deck import sysexec


def put(path: str, text) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(f"{text}\n")


def get(path: str) -> str:
    with open(path) as f:
        return f.read().strip()


def board(ctx, name="ONEXPLAYER 3", release="7.4.0-rc1-1-cachyos"):
    put(ctx.sys_path("/sys/class/dmi/id/board_name"), name)
    put(ctx.sys_path("/proc/sys/kernel/osrelease"), release)
    put(ctx.sys_path("/proc/sys/kernel/random/boot_id"), "boot-1")


def oxp_ec(ctx, hwmon="hwmon5", enable=2, pwm=0, rpm=2900) -> str:
    """The oxp_ec hwmon; a decoy hwmon of another name comes first."""
    put(ctx.sys_path("/sys/class/hwmon/hwmon0/name"), "acpitz")
    p = ctx.sys_path(f"/sys/class/hwmon/{hwmon}")
    put(os.path.join(p, "name"), "oxp_ec")
    put(os.path.join(p, "pwm1_enable"), enable)
    put(os.path.join(p, "pwm1"), pwm)
    put(os.path.join(p, "fan1_input"), rpm)
    return p


def coretemp(ctx, milli=62000, hwmon="hwmon3") -> str:
    p = ctx.sys_path(f"/sys/class/hwmon/{hwmon}")
    put(os.path.join(p, "name"), "coretemp")
    put(os.path.join(p, "temp1_label"), "Core 0")
    put(os.path.join(p, "temp1_input"), 40000)
    put(os.path.join(p, "temp2_label"), "Package id 0")
    put(os.path.join(p, "temp2_input"), milli)
    return os.path.join(p, "temp2_input")


def battery(ctx, limit=100, behaviour="[auto] inhibit-charge inhibit-charge-awake", name="BAT0") -> str:
    put(ctx.sys_path("/sys/class/power_supply/AC/type"), "Mains")
    p = ctx.sys_path(f"/sys/class/power_supply/{name}")
    put(os.path.join(p, "type"), "Battery")
    if limit is not None:
        put(os.path.join(p, "charge_control_end_threshold"), limit)
    if behaviour is not None:
        put(os.path.join(p, "charge_behaviour"), behaviour)
    return p


def set_behaviour(path: str, value: str) -> None:
    """What the kernel shows after a write: the bracketed word moves."""
    words = ["auto", "inhibit-charge", "inhibit-charge-awake"]
    put(path, " ".join(f"[{w}]" if w == value else w for w in words))


def sched_ext(ctx) -> None:
    os.makedirs(ctx.sys_path("/sys/kernel/sched_ext"), exist_ok=True)


class Bus:
    """sysexec.run for busctl and systemctl. Answers:
    loader: None (not running) or {"sched", "mode", "args"}; switch_error: an error for the next Switch* calls;
    lpmd_active; lpmd: None (not on the bus) or its state ("AUTO", "ON", "OFF"); lpmd_errors: errors to give to the
    next privileged calls, in order; getstate: False → GetState fails (an old build)."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.loader = {"sched": "scx_lavd", "mode": 0, "args": []}
        self.switch_error = None
        self.lpmd_active = False
        self.lpmd = "AUTO"
        self.lpmd_errors: list[str] = []
        self.getstate = True
        self.other = None           # fn(argv, kw) -> Result for anything else

    def __call__(self, argv, **kw):
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        name = os.path.basename(argv[0])
        if name == "systemctl":
            return sysexec.Result(0 if self.lpmd_active else 3, "", "")
        if name == "busctl":
            return self.busctl(argv[1:])
        if self.other is not None:
            return self.other(argv, kw)
        raise AssertionError(f"unexpected program {argv}")

    @staticmethod
    def ok(data=None, kind="s"):
        return sysexec.Result(0, "" if data is None else json.dumps({"type": kind, "data": data}) + "\n", "")

    @staticmethod
    def fail(text):
        return sysexec.Result(1, "", text + "\n")

    def busctl(self, a):
        assert a[:2] == ["--system", "--auto-start=no"], a
        a = a[2:]
        if a[:1] == ["--json=short"]:
            a = a[1:]
        if a[1:4] == ["org.scx.Loader", "/org/scx/Loader", "org.scx.Loader"]:
            if self.loader is None:
                return self.fail("Call failed: The name org.scx.Loader was not provided by any .service files")
            if a[0] == "get-property":
                prop = a[4]
                if prop == "CurrentScheduler":
                    return self.ok(self.loader["sched"])
                if prop == "SchedulerMode":
                    return self.ok(self.loader["mode"], "u")
                if prop == "CurrentSchedulerArgs":
                    return self.ok(self.loader["args"], "as")
            if a[0] == "call":
                if self.switch_error:
                    return self.fail(self.switch_error)
                if a[4] == "SwitchScheduler":
                    assert a[5] == "su", a
                    self.loader = {"sched": a[6], "mode": int(a[7]), "args": []}
                    return self.ok()
                if a[4] == "SwitchSchedulerWithArgs":
                    assert a[5] == "sas" and int(a[7]) == len(a[8:]), a
                    self.loader = {"sched": a[6], "mode": 0, "args": a[8:]}
                    return self.ok()
            raise AssertionError(f"unexpected scx call {a}")
        if a[1:4] == ["org.freedesktop.intel_lpmd", "/org/freedesktop/intel_lpmd", "org.freedesktop.intel_lpmd"]:
            assert a[0] == "call", a
            if self.lpmd is None:
                return self.fail("Call failed: The name org.freedesktop.intel_lpmd was not provided")
            method = a[4]
            if method == "GetState":
                return self.ok([self.lpmd]) if self.getstate else self.fail("Call failed: Unknown method")
            if self.lpmd_errors:
                return self.fail(self.lpmd_errors.pop(0))
            self.lpmd = {"LPM_FORCE_OFF": "OFF", "LPM_FORCE_ON": "ON", "LPM_AUTO": "AUTO"}[method]
            return self.ok()
        raise AssertionError(f"unexpected busctl {a}")

    def bus_calls(self, method=None):
        """The busctl argv's, or only the method calls named `method`."""
        out = [c for c in self.calls if os.path.basename(c[0]) == "busctl"]
        if method is not None:
            out = [c for c in out if "call" in c and c[c.index("call") + 4] == method]
        return out

    def privileged(self):
        return [c[c.index("call") + 4] for c in self.bus_calls()
                if "call" in c and "org.freedesktop.intel_lpmd" in c and c[-1] != "GetState"]
