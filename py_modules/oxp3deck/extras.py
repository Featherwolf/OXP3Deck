"""Extras (DESIGN.md "Extras"): the battery charge limit and charge behaviour and the fan mode (kernel 7.4+, the
ONEXPLAYER 3 only, through the oxp_ec driver), CachyOS's scx_lavd mode through scx-loader's D-Bus API, and
intel_lpmd off while a game runs through its D-Bus API.

The D-Bus names and their behaviour come from the sources (no code copied): scx-loader at 259bb6c
(configs/org.scx.Loader.xml, crates/scx_loader/src/dbus.rs) and intel-lpmd at 9ece012
(src/intel_lpmd_dbus_interface.xml, src/lpmd_dbus_server.c: privileged calls need uid 0 and one is allowed per 2 s).

Its own RLock, never held while power.py's is (main.py calls the two one after the other; lpmd_paused, which
power.py calls under its lock, reads without taking this one). Every public function answers {ok, error, ...} and
never raises; subprocesses through sysexec.run (clean environment, argv list) on the caller's executor thread.
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import threading
import time

from . import context, sysexec

log = logging.getLogger("oxp3deck")

SETTINGS_FILE = "extras.json"
RUN_FILE = "extras-run.json"
VERSION = 1
BOARD = "ONEXPLAYER 3"                 # /sys/class/dmi/id/board_name, exactly (oxpec.c DMI_EXACT_MATCH, 7.4-rc1)
CHARGE_MIN, CHARGE_MAX = 50, 100
BEHAVIOURS = ("auto", "inhibit-charge-awake")    # never "inhibit-charge": it also blocks charging while asleep
FAN_MODES = ("auto", "quiet", "max")
FAN_HOT_C = 90
FAN_QUIET_PWM = 102                    # about 40 % (the driver scales 0..255 to the EC's 0..184); tune on the device
SCX_MODES = {"auto": 0, "gaming": 1, "powersave": 2}
SCX_MODE_NAMES = {0: "auto", 1: "gaming", 2: "powersave", 3: "lowlatency", 4: "server"}
LAVD = "scx_lavd"
SCX_CHECK_S = 10                       # the loader's properties (and lpmd's GetState) are read at most this often
LPMD_ACTIVE_S = 60                     # systemctl is-active intel_lpmd.service, cached
RESUME_DELAY_S = 3                     # the fan mode and the charge settings are written again this long after resume
RESUME_QUIET_S = 10                    # no override check this long after a resume
CHARGE_CHECK_S = 10
BOOTTIME_JUMP_S = 2.0
BUS_TIMEOUT_S = 2                      # each D-Bus call in a tick: a hung service delays the fan safety this long
UNLOAD_TIMEOUT_S = 1                   # each D-Bus call at unload (main.py gives unload 3 s in all)
WATCH_START_S = 2                      # how long the sleep watch's programs get to start
HWMON_RESCAN_S = 30
SUSPEND_SUCCESS = "/sys/power/suspend_stats/success"
SCHED_EXT = "/sys/kernel/sched_ext"

SCX = ("org.scx.Loader", "/org/scx/Loader", "org.scx.Loader")
LPMD = ("org.freedesktop.intel_lpmd", "/org/freedesktop/intel_lpmd", "org.freedesktop.intel_lpmd")
LPMD_UNIT = "intel_lpmd.service"
SLEEP_MATCH = ("--match=type='signal',sender='org.freedesktop.login1',interface='org.freedesktop.login1.Manager',"
               "member='PrepareForSleep'")
_SCHED_NAME = re.compile(r"^scx_[a-z0-9_]{1,40}$")
_SCHED_ARG = re.compile(r"^[-A-Za-z0-9_.=,]{1,64}$")
MAX_ARGS = 32
OPTION_DEFAULTS = {"charge_limit": None, "charge_behaviour": None, "lpmd_game_off": False}
WHATS = ("fan", "scx", "charge_limit", "charge_behaviour")
_CHARGE = {"limit": ("charge_limit", "charge_control_end_threshold"),
           "behaviour": ("charge_behaviour", "charge_behaviour")}
ARGS_NOT_RESTORED = "the scheduler's own arguments could not be put back; restart scx_loader"

_LOCK = threading.RLock()
_STATES: dict = {}
_PAUSED: dict = {}                     # settings_dir -> intel_lpmd paused by us (read without the lock)


def _monotonic() -> float:
    return time.monotonic()


def _clock_gap() -> float | None:
    """CLOCK_BOOTTIME − CLOCK_MONOTONIC: grows by the time spent suspended."""
    try:
        return time.clock_gettime(time.CLOCK_BOOTTIME) - time.clock_gettime(time.CLOCK_MONOTONIC)
    except (AttributeError, OSError):
        return None


# ---- small helpers -----------------------------------------------------------------------------------------------

def _read(path: str | None, limit: int = 4096) -> str | None:
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", errors="replace").strip()
    except OSError:
        return None


def _write(path: str, text: str) -> None:
    """One sysfs write. Raises OSError."""
    fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.write(fd, text.encode())
    finally:
        os.close(fd)


def _int(text):
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return None


def _why(e: OSError) -> str:
    return e.strerror or str(e)


def _bracketed(text: str | None) -> tuple[str | None, list[str]]:
    """'[auto] inhibit-charge inhibit-charge-awake' → ('auto', [the words]); one plain word is the value."""
    if not text:
        return None, []
    words = [w.strip("[]") for w in text.split()]
    for w in text.split():
        if w.startswith("[") and w.endswith("]"):
            return w[1:-1], words
    return (words[0] if len(words) == 1 else None), words


def _killpg(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        pass


def _busctl() -> str:
    return sysexec.which("busctl") or "/usr/bin/busctl"


def _bus(args: list[str], timeout: float) -> tuple[bool, str, str]:
    """busctl --system --auto-start=no ARGS: (ok, stdout, the error's last line). OXP3 Deck never D-Bus-activates
    a service."""
    r = sysexec.run([_busctl(), "--system", "--auto-start=no", *args], timeout=timeout)
    if r.rc == 0:
        return True, r.out, ""
    lines = (r.err or r.out or "").strip().splitlines()
    return False, r.out, (lines[-1] if lines else f"busctl exit {r.rc}")


def _json_data(out: str):
    """The `data` of busctl --json=short's first line, or None."""
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            got = json.loads(line)
        except ValueError:
            return None
        return got.get("data") if isinstance(got, dict) else None
    return None


# ---- settings and run state ----------------------------------------------------------------------------------------

def _limit_ok(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and CHARGE_MIN <= v <= CHARGE_MAX


def _norm_opts(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = dict(OPTION_DEFAULTS)
    if _limit_ok(raw.get("charge_limit")):
        out["charge_limit"] = raw["charge_limit"]
    if raw.get("charge_behaviour") in BEHAVIOURS:
        out["charge_behaviour"] = raw["charge_behaviour"]
    if isinstance(raw.get("lpmd_game_off"), bool):
        out["lpmd_game_off"] = raw["lpmd_game_off"]
    return out


def _fresh_run(boot: str) -> dict:
    return {"boot_id": boot,
            "fan": {"ours": None, "reverted": None, "overridden": None, "key": None, "held": None},
            "scx": {"before": None, "ours": None, "overridden": None, "held": None},
            "lpmd": {"paused": False, "before": None, "app": None, "error": None, "again": None, "gave_up": None},
            "charge": {"limit": None, "behaviour": None, "overridden": {"limit": None, "behaviour": None}},
            "suspend_count": None}


def _str_or_none(v, limit=200):
    return v[:limit] if isinstance(v, str) else None


def _load_run(ctx) -> dict:
    boot = _read(ctx.sys_path("/proc/sys/kernel/random/boot_id"), 100) or ""
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
    fan, scx, lp, ch = (got.get(k) if isinstance(got.get(k), dict) else {} for k in ("fan", "scx", "lpmd", "charge"))
    run["fan"].update({"ours": fan.get("ours") if fan.get("ours") in ("quiet", "max") else None,
                       "reverted": _str_or_none(fan.get("reverted")), "overridden": _str_or_none(fan.get("overridden")),
                       "key": _str_or_none(fan.get("key")),
                       "held": fan.get("held") if fan.get("held") in FAN_MODES else None})
    before = scx.get("before")
    if isinstance(before, dict) and isinstance(before.get("sched"), str) and isinstance(before.get("mode"), int) \
            and isinstance(before.get("args"), list) and all(isinstance(a, str) for a in before["args"]):
        run["scx"]["before"] = {"sched": before["sched"], "mode": before["mode"], "args": before["args"][:MAX_ARGS]}
    run["scx"].update({"ours": scx.get("ours") if scx.get("ours") in SCX_MODES.values() else None,
                       "overridden": _str_or_none(scx.get("overridden")),
                       "held": scx.get("held") if scx.get("held") in SCX_MODES else None})
    run["lpmd"].update({"paused": lp.get("paused") is True,
                        "before": lp.get("before") if lp.get("before") in ("AUTO", "ON") else None,
                        "app": _str_or_none(lp.get("app"), 20), "error": _str_or_none(lp.get("error")),
                        "again": _str_or_none(lp.get("again"), 20), "gave_up": _str_or_none(lp.get("gave_up"), 20)})
    over = ch.get("overridden") if isinstance(ch.get("overridden"), dict) else {}
    run["charge"].update({"limit": ch.get("limit") if _limit_ok(ch.get("limit")) else None,
                          "behaviour": ch.get("behaviour") if ch.get("behaviour") in BEHAVIOURS else None,
                          "overridden": {k: _str_or_none(over.get(k)) for k in ("limit", "behaviour")}})
    if isinstance(got.get("suspend_count"), int):
        run["suspend_count"] = got["suspend_count"]
    return run


class _St:
    def __init__(self, ctx):
        self.store = context.Settings(os.path.join(ctx.settings_dir, SETTINGS_FILE))
        self.opts = _norm_opts(self.store.all())
        self.run = _load_run(ctx)
        self.saved = None                    # the run file's last written text
        self.run_warned = False
        self.active = None                   # the last active profile tick or sync got
        self.seen = False
        self.prev_susp = self.run.get("suspend_count")
        self.prev_gap = None
        self.resumed_at: float | None = None
        self.charge_at: float | None = None  # write the charge settings then (None: not pending)
        self.charge_done = False             # the first tick of this process wrote them
        self.charge_checked: float | None = None
        self.charge_error = {"limit": None, "behaviour": None}
        self.slept = False                   # the fan is on Auto for a sleep; the mode comes back at fan_again_at
        self.fan_again_at: float | None = None
        self.watch: _Watch | None = None
        self.hwmon: dict = {}                # name -> (path or None, when looked up)
        self.scx_cache: dict | None = None   # {"at", "sched", "mode", "error"}
        self.scx_retry_at: float | None = None
        self.scx_note: str | None = None
        self.lpmd_active: tuple | None = None   # (bool, when)
        self.lpmd_state: tuple | None = None    # (state, when)
        self.lpmd_off: tuple | None = None      # (app, when): GetState said OFF for this game
        self.lpmd_checked: float | None = None
        _PAUSED[ctx.settings_dir] = self.run["lpmd"]["paused"]


def _get(ctx) -> _St:
    st = _STATES.get(ctx.settings_dir)
    if st is None:
        st = _STATES[ctx.settings_dir] = _St(ctx)
    return st


def _save_run(ctx, st: _St) -> None:
    _PAUSED[ctx.settings_dir] = st.run["lpmd"]["paused"]
    blob = json.dumps(st.run, sort_keys=True) + "\n"
    if blob == st.saved:
        return
    try:
        context.write_atomic(os.path.join(sysexec.run_dir(ctx), RUN_FILE), blob.encode(), 0o600)
        st.saved = blob
    except OSError as e:
        if not st.run_warned:
            log.warning("extras: cannot write the run state (kept in memory): %s", e)
            st.run_warned = True


def _norm_active(active) -> dict:
    if not isinstance(active, dict):
        return {"key": None, "app": None, "values": {}}
    values = active.get("values") if isinstance(active.get("values"), dict) else {}
    return {"key": active.get("key") if isinstance(active.get("key"), str) else None,
            "app": active.get("app") if isinstance(active.get("app"), str) and active.get("app") else None,
            "values": values}


# ---- discovery ---------------------------------------------------------------------------------------------------

def _hwmon(ctx, st: _St, name: str) -> str | None:
    """The /sys/class/hwmon/hwmonN folder whose `name` is `name` (by name, never by number); a miss is looked up
    again after HWMON_RESCAN_S."""
    path, at = st.hwmon.get(name, (None, None))
    now = _monotonic()
    if path and _read(os.path.join(path, "name")) == name:
        return path
    if path is None and at is not None and now - at < HWMON_RESCAN_S:
        return None
    found = None
    base = ctx.sys_path("/sys/class/hwmon")
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        entries = []
    for e in entries:
        p = os.path.join(base, e)
        if _read(os.path.join(p, "name")) == name:
            found = p
            break
    st.hwmon[name] = (found, now)
    return found


def _battery(ctx) -> str | None:
    base = ctx.sys_path("/sys/class/power_supply")
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        return None
    for e in entries:
        p = os.path.join(base, e)
        if _read(os.path.join(p, "type")) == "Battery":
            return p
    return None


def _gates(ctx, st: _St) -> dict:
    """{board_ok, kernel, ec, battery, why}: the battery and fan controls exist only with the board named exactly
    ONEXPLAYER 3 and an oxp_ec hwmon (mainline 7.4-rc1's oxpec.c has the entry; 7.2 and 7.3 do not)."""
    board_ok = _read(ctx.sys_path("/sys/class/dmi/id/board_name"), 256) == BOARD
    kernel = _read(ctx.sys_path("/proc/sys/kernel/osrelease"), 256) or ""
    ec = _hwmon(ctx, st, "oxp_ec") if board_ok else None
    why = None
    if not board_ok:
        why = "Only on the ONEXPLAYER 3."
    elif ec is None:
        why = f"Needs Linux 7.4 or newer (this is {kernel or 'unknown'})."
    return {"board_ok": board_ok, "kernel": kernel, "ec": ec, "battery": _battery(ctx) if ec else None,
            "why": why}


def _fan_file(g: dict, name: str) -> str | None:
    if not g["ec"]:
        return None
    p = os.path.join(g["ec"], name)
    return p if os.path.exists(p) else None


def _charge_file(g: dict, which: str) -> str | None:
    if not g["battery"]:
        return None
    p = os.path.join(g["battery"], _CHARGE[which][1])
    return p if os.path.exists(p) else None


def _cpu_temp(ctx, st: _St) -> float | None:
    """The coretemp package temperature in °C (the tempN whose label is "Package id 0", else temp1), or None."""
    hw = _hwmon(ctx, st, "coretemp")
    if not hw:
        return None
    pick = os.path.join(hw, "temp1_input")
    try:
        names = sorted(os.listdir(hw))
    except OSError:
        names = []
    for n in names:
        m = re.fullmatch(r"temp(\d+)_label", n)
        if m and _read(os.path.join(hw, n)) == "Package id 0":
            pick = os.path.join(hw, f"temp{m.group(1)}_input")
            break
    milli = _int(_read(pick))
    return None if milli is None else milli / 1000


# ---- the sleep watch ---------------------------------------------------------------------------------------------

class _Watch:
    """While the fan is on Quiet or Max: a logind delay inhibitor plus a busctl monitor of PrepareForSleep. Before
    sleep the fan goes to Auto, then the inhibitor ends (logind waits for it); after resume a new inhibitor is taken
    and the next tick writes the mode again after RESUME_DELAY_S. A program that does not start or ends on its own
    makes the watch dead (`ended`), and the fan goes to Auto at once."""

    def __init__(self, ctx, st: _St):
        self.ctx, self.st = ctx, st
        self.lock = threading.Lock()
        self.stopping = False
        self.mon_pid: int | None = None
        self.inh_pid: int | None = None
        self.ended: str | None = None

    @property
    def alive(self) -> bool:
        return not self.stopping and self.ended is None

    def start(self) -> bool:
        if self._spawn("monitor") is None or self._spawn("inhibit") is None:
            self.ended = self.ended or "a program did not start"
            self.stop()
            return False
        return True

    def stop(self) -> None:
        with self.lock:
            self.stopping = True
            pids = [p for p in (self.mon_pid, self.inh_pid) if p]
            self.mon_pid = self.inh_pid = None
        for pid in pids:
            _killpg(pid)

    def _argv(self, kind: str) -> list[str]:
        if kind == "monitor":
            return [_busctl(), "--system", "--json=short", "monitor", SLEEP_MATCH]
        return [sysexec.which("systemd-inhibit") or "/usr/bin/systemd-inhibit", "--what=sleep", "--mode=delay",
                "--who=OXP3Deck", "--why=Fan back to Auto before sleep", sysexec.which("sleep") or "/usr/bin/sleep",
                "infinity"]

    def _spawn(self, kind: str) -> int | None:
        started = threading.Event()
        box: dict = {}

        def on_start(pid):
            with self.lock:
                if kind == "monitor":
                    self.mon_pid = pid
                else:
                    self.inh_pid = pid
            box["pid"] = pid
            started.set()

        def body():
            try:
                r = sysexec.run(self._argv(kind), start_new_session=True, on_start=on_start,
                                on_line=self._line if kind == "monitor" else None)
            except Exception as e:      # never raises, but a thread must not die silently
                r = sysexec.Result(-1, "", f"{type(e).__name__}: {e}")
            box["result"] = r
            started.set()
            self._ended(kind, box.get("pid"), r)

        threading.Thread(target=body, name=f"oxp3deck-{kind}", daemon=True).start()
        started.wait(WATCH_START_S)
        if "result" in box or "pid" not in box:
            return None
        return box["pid"]

    def _ended(self, kind: str, pid, r) -> None:
        with self.lock:
            if self.stopping:
                return
            if kind == "inhibit" and pid is not None and pid != self.inh_pid:
                return                   # the one we ended for a sleep
            why = (r.err or "").strip().splitlines()[-1:] if r is not None else []
            self.ended = f"{'the sleep monitor' if kind == 'monitor' else 'the sleep inhibitor'} ended" + \
                (f" ({why[0][:120]})" if why else "")
        log.warning("extras: %s; the fan goes back to Auto", self.ended)
        self._fan_auto()

    def _fan_auto(self) -> None:
        """pwm1_enable 2 now, without the module lock (a tick may hold it for seconds; logind waits 5 s at most)."""
        st = self.st
        if st.run["fan"]["ours"] is None:
            return
        path = _fan_file(_gates(self.ctx, st), "pwm1_enable")
        if path:
            try:
                _write(path, "2")
            except OSError as e:
                log.error("extras: cannot set the fan to Auto: %s", _why(e))

    def _line(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if not isinstance(msg, dict) or msg.get("member") != "PrepareForSleep":
            return
        data = (msg.get("payload") or {}).get("data") if isinstance(msg.get("payload"), dict) else None
        going = data[0] if isinstance(data, list) and data else None
        if going is True:
            self.st.slept = True
            self.st.fan_again_at = None
            self._fan_auto()
            with self.lock:
                pid, self.inh_pid = self.inh_pid, None
            if pid:
                _killpg(pid)             # logind may suspend now
            log.info("extras: going to sleep: fan on Auto")
        elif going is False:
            now = _monotonic()
            self.st.resumed_at = now
            self.st.fan_again_at = now + RESUME_DELAY_S
            if not self.stopping and self._spawn("inhibit") is None:
                with self.lock:
                    self.ended = self.ended or "the sleep inhibitor did not start again"


def _watch_ok(ctx, st: _St) -> bool:
    if st.watch is not None and st.watch.alive:
        return True
    if st.watch is not None:            # died: the fan stays on Auto until a change
        st.watch.stop()
        st.watch = None
        return False
    w = _Watch(ctx, st)
    if not w.start():
        return False
    st.watch = w
    return True


def _stop_watch(st: _St) -> None:
    if st.watch is not None:
        st.watch.stop()
        st.watch = None


# ---- fan ---------------------------------------------------------------------------------------------------------

def _fan_write(g: dict, mode: str) -> str | None:
    """Write `mode` and read pwm1_enable back: None, or why it failed."""
    en, pwm = _fan_file(g, "pwm1_enable"), _fan_file(g, "pwm1")
    if en is None or (mode == "quiet" and pwm is None):
        return "the fan control files are missing"
    try:
        if mode == "auto":
            _write(en, "2")
        elif mode == "quiet":
            _write(en, "1")
            _write(pwm, str(FAN_QUIET_PWM))
        else:
            _write(en, "0")              # the driver sets full speed
    except OSError as e:
        return _why(e)
    got = _read(en)
    if (mode == "auto" and got == "2") or (mode != "auto" and got in ("0", "1")):
        return None
    return f"it reads {got!r}"


def _fan_hold(fan: dict, wanted: str, key, mode: str, why: str) -> None:
    fan.update({"ours": None, mode: why, "held": wanted, "key": key})


def _fan_back(g: dict, fan: dict, st: _St, wanted: str, key, why: str, did: list) -> None:
    """Back to Auto (once more) and hold there until a fan setting (or, after a revert, the profile) changes."""
    err = _fan_write(g, "auto")
    if err:
        log.error("extras: cannot set the fan back to Auto: %s", err)
    _fan_hold(fan, wanted, key, "reverted", why)
    _stop_watch(st)
    did.append("fan auto: " + why)
    log.warning("extras: fan back to Auto: %s", why)


def _fan_safety(ctx, st: _St, g: dict, act: dict, did: list) -> None:
    fan = st.run["fan"]
    if fan["ours"] not in ("quiet", "max") or _fan_file(g, "pwm1_enable") is None:
        return
    t = _cpu_temp(ctx, st)
    # Max is already the most cooling the fan gives: going back to Auto when hot could slow it down. Max goes back
    # only on an unreadable temperature (or an error, sleep, unload).
    if t is not None and (t < FAN_HOT_C or fan["ours"] == "max"):
        return
    why = f"The CPU reached {FAN_HOT_C} °C" if t is not None else "The temperature couldn't be read"
    _fan_back(g, fan, st, fan["ours"], act["key"], why, did)


def _fan_step(ctx, st: _St, g: dict, act: dict, now: float, did: list) -> None:
    fan = st.run["fan"]
    en = _fan_file(g, "pwm1_enable")
    if en is None:
        fan["ours"] = None
        _stop_watch(st)
        return
    wanted = act["values"].get("fan_mode")
    wanted = wanted if wanted in FAN_MODES else "auto"
    key = act["key"]
    if fan["reverted"] or fan["overridden"]:
        if wanted != fan["held"] or (fan["reverted"] and key != fan["key"]):
            fan.update({"reverted": None, "overridden": None, "held": None, "key": None})   # a change: try again
        else:
            if fan["ours"] is None:
                _stop_watch(st)
            return
    force = False
    if st.slept:
        if st.fan_again_at is None or now < st.fan_again_at:
            return
        st.slept, st.fan_again_at, force = False, None, True
    if wanted == "auto":
        _stop_watch(st)
        if fan["ours"] is None and not force:
            return                       # never write when nothing was changed
        err = _fan_write(g, "auto")
        fan["ours"] = None
        if err:
            log.error("extras: fan back to Auto failed: %s", err)
        did.append("fan auto")
        return
    if not _watch_ok(ctx, st):
        why = "Can't watch for sleep, so the fan stays on Auto"
        if fan["ours"] is not None:
            _fan_back(g, fan, st, wanted, key, why, did)
        else:
            _fan_hold(fan, wanted, key, "reverted", why)
            did.append("fan: " + why)
        return
    if fan["ours"] == wanted and not force:
        if st.resumed_at is not None and now - st.resumed_at < RESUME_QUIET_S:
            return
        if _read(en) == "2":
            _fan_hold(fan, wanted, key, "overridden", "Something else set the fan back to Auto")
            _stop_watch(st)
            did.append("fan overridden")
            log.warning("extras: something else set the fan back to Auto; not writing it again")
        return
    err = _fan_write(g, wanted)
    if err:
        _fan_back(g, fan, st, wanted, key, f"Fan control failed: back to Auto ({err})", did)
        return
    fan["ours"] = wanted
    did.append(f"fan {wanted}")
    log.info("extras: fan %s", wanted)


# ---- scx ---------------------------------------------------------------------------------------------------------

def _scx_prop(name: str, timeout: float):
    ok, out, err = _bus(["--json=short", "get-property", *SCX, name], timeout)
    return (_json_data(out), None) if ok else (None, err)


def _scx_read(st: _St, now: float, force: bool = False, timeout: float = BUS_TIMEOUT_S) -> dict:
    """{sched, mode, error}: CurrentScheduler and SchedulerMode, read at most every SCX_CHECK_S unless `force`.
    sched None: the loader did not answer."""
    c = st.scx_cache
    if c is not None and not force and now - c["at"] < SCX_CHECK_S:
        return c
    sched, err = _scx_prop("CurrentScheduler", timeout)
    mode = None
    if isinstance(sched, str):
        mode, err2 = _scx_prop("SchedulerMode", timeout)
        mode = mode if isinstance(mode, int) and not isinstance(mode, bool) else None
        err = err or err2
    else:
        sched = None
    st.scx_cache = {"at": now, "sched": sched, "mode": mode, "error": err}
    return st.scx_cache


def _scx_switch(st: _St, name: str, mode: int, timeout: float) -> str | None:
    ok, _out, err = _bus(["call", *SCX, "SwitchScheduler", "su", name, str(mode)], timeout)
    return None if ok else err


def _scx_restore(st: _St, now: float, timeout: float, did: list) -> bool:
    """Put back what the loader ran before OXP3 Deck's first change: its own arguments when it had them, else the
    mode. True when done (or nothing can be done)."""
    scx = st.run["scx"]
    before = scx["before"]
    if before is None:
        scx["ours"] = None
        return True
    if not _SCHED_NAME.match(before["sched"]):
        st.scx_note = ARGS_NOT_RESTORED
        scx["before"] = scx["ours"] = None
        return True
    args = before["args"]
    if args and len(args) <= MAX_ARGS and all(_SCHED_ARG.match(a) for a in args):
        ok, _out, err = _bus(["call", *SCX, "SwitchSchedulerWithArgs", "sas", before["sched"], str(len(args)), *args],
                             timeout)
        err = None if ok else err
    else:
        if args:
            st.scx_note = ARGS_NOT_RESTORED
        err = _scx_switch(st, before["sched"], before["mode"], timeout)
    if err:
        st.scx_note = f"Couldn't put the scheduler mode back: {err}"
        log.error("extras: scx restore failed: %s", err)
        return False
    scx["before"] = scx["ours"] = None
    st.scx_cache = None
    did.append("scx restored")
    log.info("extras: scheduler mode restored")
    return True


def _scx_step(ctx, st: _St, act: dict, now: float, did: list) -> None:
    if not os.path.isdir(ctx.sys_path(SCHED_EXT)):
        return
    scx = st.run["scx"]
    name = act["values"].get("scx_mode")
    name = name if name in SCX_MODES else None
    if scx["overridden"]:
        if name == scx["held"]:
            return
        scx.update({"overridden": None, "held": None})      # a change of scx_mode: act again
    if st.scx_retry_at is not None and now < st.scx_retry_at:
        return
    if name is None:
        if scx["before"] is not None or scx["ours"] is not None:
            c = _scx_read(st, now, force=True)
            if c["sched"] is None:
                st.scx_retry_at = now + SCX_CHECK_S              # not answering: later
                return
            if c["sched"] != LAVD or (scx["ours"] is not None and c["mode"] != scx["ours"]):
                scx["before"] = scx["ours"] = None              # someone else has changed it since: theirs now
                return
            if not _scx_restore(st, now, BUS_TIMEOUT_S, did):
                st.scx_retry_at = now + SCX_CHECK_S
        return
    want = SCX_MODES[name]
    c = _scx_read(st, now)
    if c["sched"] is None:
        return
    if scx["ours"] is not None and (c["sched"] != LAVD or c["mode"] != scx["ours"]):
        scx.update({"overridden": "Something else changed the scheduler mode", "held": name, "before": None,
                    "ours": None})
        did.append("scx overridden")
        log.warning("extras: something else changed the scheduler mode; not changing it again")
        return
    if c["sched"] != LAVD or c["mode"] == want:
        return
    c = _scx_read(st, now, force=True)          # right before a call
    if c["sched"] != LAVD or c["mode"] == want:
        return
    if scx["before"] is None:
        args, _err = _scx_prop("CurrentSchedulerArgs", BUS_TIMEOUT_S)
        args = [a for a in args if isinstance(a, str)] if isinstance(args, list) else []
        scx["before"] = {"sched": c["sched"], "mode": c["mode"] if c["mode"] is not None else 0, "args": args}
    err = _scx_switch(st, LAVD, want, BUS_TIMEOUT_S)
    if err:
        st.scx_note = f"Couldn't switch the scheduler mode: {err}"
        st.scx_retry_at = now + SCX_CHECK_S
        log.error("extras: SwitchScheduler failed: %s", err)
        return
    scx["ours"] = want
    st.scx_note = None
    st.scx_cache = {"at": now, "sched": LAVD, "mode": want, "error": None}
    did.append(f"scx {name}")
    log.info("extras: scheduler mode %s", name)


# ---- intel_lpmd --------------------------------------------------------------------------------------------------

def _lpmd_service(st: _St, now: float) -> bool:
    if st.lpmd_active is not None and now - st.lpmd_active[1] < LPMD_ACTIVE_S:
        return st.lpmd_active[0]
    systemctl = sysexec.which("systemctl") or "/usr/bin/systemctl"
    r = sysexec.run([systemctl, "is-active", "--quiet", LPMD_UNIT], timeout=BUS_TIMEOUT_S)
    st.lpmd_active = (r.rc == 0, now)
    return r.rc == 0


def _lpmd_get(timeout: float = BUS_TIMEOUT_S) -> str | None:
    """GetState (OFF, ON, AUTO, ...), or None (an error, or a build without it)."""
    ok, out, _err = _bus(["--json=short", "call", *LPMD, "GetState"], timeout)
    data = _json_data(out) if ok else None
    if isinstance(data, list) and data and isinstance(data[0], str):
        return data[0]
    return None


def _lpmd_call(method: str, timeout: float = BUS_TIMEOUT_S) -> str | None:
    ok, _out, err = _bus(["call", *LPMD, method], timeout)
    return None if ok else err


def _lpmd_failed(lp: dict, err: str) -> None:
    if "rate limited" in err:
        return                           # one privileged call per 2 s (anyone's): again at the next tick
    lp["error"] = err[:200]
    log.error("extras: intel_lpmd: %s", err)


def _lpmd_restore(lp: dict, timeout: float = BUS_TIMEOUT_S) -> bool:
    err = _lpmd_call("LPM_FORCE_ON" if lp["before"] == "ON" else "LPM_AUTO", timeout)
    if err:
        _lpmd_failed(lp, err)
        return False
    lp.update({"paused": False, "before": None, "app": None, "error": None})
    log.info("extras: intel_lpmd back on")
    return True


def _lpmd_step(ctx, st: _St, act: dict, now: float, did: list) -> bool:
    """At most one privileged intel_lpmd call. True when `paused` changed."""
    lp = st.run["lpmd"]
    app = act["app"]
    if app is None:
        lp["again"] = lp["gave_up"] = None
    if not st.opts["lpmd_game_off"] and not lp["paused"]:
        return False
    if not _lpmd_service(st, now):
        if lp["paused"]:
            lp.update({"paused": False, "before": None, "app": None})   # the daemon is gone: nothing to put back
            did.append("lpmd gone")
            return True
        return False
    if lp["paused"]:
        if not st.opts["lpmd_game_off"] or app != lp["app"]:
            if _lpmd_restore(lp):
                did.append("lpmd restored")
                return True
            return False
        if st.lpmd_checked is None or now - st.lpmd_checked >= SCX_CHECK_S:
            st.lpmd_checked = now
            state = _lpmd_get()
            if state is not None and state != "OFF":            # the daemon restarted in its own mode
                if lp["again"] == app:
                    lp["gave_up"] = app
                else:
                    lp["again"] = app
                lp.update({"paused": False, "before": None})
                did.append("lpmd not paused any more")
                log.warning("extras: intel_lpmd left LPM_FORCE_OFF (restarted?)")
                return True
        return False
    if app is None or lp["gave_up"] == app:
        return False
    if st.lpmd_off is not None and st.lpmd_off[0] == app and now - st.lpmd_off[1] < SCX_CHECK_S:
        return False
    state = _lpmd_get()
    if state == "OFF":
        st.lpmd_off = (app, now)
        return False
    err = _lpmd_call("LPM_FORCE_OFF")
    if err:
        _lpmd_failed(lp, err)
        return False
    lp.update({"paused": True, "before": state if state in ("AUTO", "ON") else None, "app": app, "error": None})
    st.lpmd_checked = now
    did.append("lpmd paused")
    log.info("extras: intel_lpmd paused for %s", app)
    return True


# ---- charge ------------------------------------------------------------------------------------------------------

def _charge_now(path: str | None, which: str):
    text = _read(path)
    if which == "limit":
        return _int(text)
    return _bracketed(text)[0]


def _charge_apply(ctx, st: _St, g: dict, did: list, only: str | None = None) -> str | None:
    """Write each non-null charge setting that differs and read it back. The last error, or None."""
    ch = st.run["charge"]
    error = None
    for which, (opt, _f) in _CHARGE.items():
        if only is not None and which != only:
            continue
        want = st.opts[opt]
        st.charge_error[which] = None
        if want is None or ch["overridden"][which]:
            continue
        path = _charge_file(g, which)
        if path is None:
            continue
        if which == "behaviour" and want not in _bracketed(_read(path))[1]:
            error = st.charge_error[which] = f"the battery does not offer {want}"
            continue
        got = _charge_now(path, which)
        if got != want:
            try:
                _write(path, str(want))
            except OSError as e:
                what = "charge limit" if which == "limit" else "charge behaviour"
                error = st.charge_error[which] = f"cannot set the {what}: {_why(e)}"
                log.error("extras: %s", error)
                continue
            got = _charge_now(path, which)
            if got != want:
                error = st.charge_error[which] = f"the battery reads {got!r} after writing {want!r}"
                log.error("extras: %s", error)
                continue
            did.append(f"charge {which} {want}")
            log.info("extras: charge %s %s", which, want)
        ch[which] = want
    return error


def _charge_check(st: _St, g: dict, now: float, did: list) -> None:
    ch = st.run["charge"]
    if st.charge_checked is not None and now - st.charge_checked < CHARGE_CHECK_S:
        return
    if st.resumed_at is not None and now - st.resumed_at < RESUME_QUIET_S:
        return
    st.charge_checked = now
    for which in _CHARGE:
        last = ch[which]
        if last is None or ch["overridden"][which] or st.opts[_CHARGE[which][0]] != last:
            continue
        got = _charge_now(_charge_file(g, which), which)
        if got is not None and got != last:
            ch["overridden"][which] = ("Something else changed the charge limit" if which == "limit" else
                                       "Something else changed the charging behaviour")
            ch[which] = None
            did.append(f"charge {which} overridden")
            log.warning("extras: something else changed the charge %s (%r)", which, got)


def _charge_step(ctx, st: _St, g: dict, now: float, did: list) -> None:
    if st.opts["charge_limit"] is None and st.opts["charge_behaviour"] is None:
        return
    if g["battery"] is None:
        return
    due = not st.charge_done or (st.charge_at is not None and now >= st.charge_at)
    if due:
        st.charge_done, st.charge_at = True, None
        _charge_apply(ctx, st, g, did)
        st.charge_checked = now
        return
    _charge_check(st, g, now, did)


# ---- state -------------------------------------------------------------------------------------------------------

def _state(ctx, st: _St) -> dict:
    now = _monotonic()
    g = _gates(ctx, st)
    run = st.run
    fan, scx, lp, ch = run["fan"], run["scx"], run["lpmd"], run["charge"]
    ch_ok = bool(g["board_ok"] and g["battery"] and _charge_file(g, "limit"))
    beh_path = _charge_file(g, "behaviour")
    words = _bracketed(_read(beh_path))[1] if beh_path else []
    charge = {"available": ch_ok, "why": None if ch_ok else (g["why"] or "No battery charge control was found."),
              "limit": _charge_now(_charge_file(g, "limit"), "limit") if ch_ok else None,
              "behaviour": _charge_now(beh_path, "behaviour") if ch_ok and beh_path else None,
              "behaviours": [b for b in BEHAVIOURS if b in words] if ch_ok else [],
              "overridden": dict(ch["overridden"]),
              "error": st.charge_error["limit"] or st.charge_error["behaviour"]}
    en = _fan_file(g, "pwm1_enable")
    fan_ok = bool(g["board_ok"] and en)
    raw = _read(en) if fan_ok else None
    mode_now = {"2": "auto", "0": "max"}.get(raw or "")
    if raw == "1":
        mode_now = "quiet" if fan["ours"] == "quiet" else "manual"
    fan_state = {"available": fan_ok, "why": None if fan_ok else (g["why"] or "No fan control was found."),
                 "rpm": _int(_read(_fan_file(g, "fan1_input"))) if fan_ok else None, "mode_now": mode_now,
                 "ours": fan["ours"], "reverted": fan["reverted"], "overridden": fan["overridden"],
                 "sleep_watch": st.watch is not None and st.watch.alive}
    shown = os.path.isdir(ctx.sys_path(SCHED_EXT))
    sched = mode = why = None
    if shown:
        c = _scx_read(st, now)
        sched, mode = c["sched"], SCX_MODE_NAMES.get(c["mode"]) if c["mode"] is not None else None
        if sched is None:
            why = "The scheduler loader isn't running."
        elif sched == "unknown":
            why = "No scheduler runs now."
        elif sched != LAVD:
            why = f"Only for the LAVD scheduler; {sched} runs now."
    ours_name = next((k for k, v in SCX_MODES.items() if v == scx["ours"]), None)
    scx_state = {"shown": shown, "available": shown and why is None, "why": why, "scheduler": sched, "mode": mode,
                 "ours": ours_name, "overridden": scx["overridden"], "note": st.scx_note}
    lp_shown = _lpmd_service(st, now)
    state = None
    if lp_shown:
        if st.lpmd_state is None or now - st.lpmd_state[1] >= SCX_CHECK_S:
            st.lpmd_state = (_lpmd_get(), now)
        state = st.lpmd_state[0]
    return {"board_ok": g["board_ok"], "kernel": g["kernel"], "charge": charge, "fan": fan_state, "scx": scx_state,
            "lpmd": {"shown": lp_shown, "paused": lp["paused"], "state": state, "error": lp["error"]},
            "options": dict(st.opts)}


def _answer(ctx, st: _St, ok: bool = True, error: str | None = None) -> dict:
    try:
        extras = _state(ctx, st)
    except Exception as e:
        log.exception("extras: state")
        return {"ok": False, "error": error or f"extras: {type(e).__name__}: {e}", "extras": None}
    return {"ok": ok, "error": error, "extras": extras}


# ---- API ---------------------------------------------------------------------------------------------------------

def info(ctx) -> dict:
    """ExtrasInfoRes: {ok, error, extras: ExtrasState}."""
    try:
        with _LOCK:
            return _answer(ctx, _get(ctx))
    except Exception as e:
        log.exception("extras: info")
        return {"ok": False, "error": f"extras: {type(e).__name__}: {e}", "extras": None}


def _check_opts(opts, g: dict, words: list[str]) -> str | None:
    if not isinstance(opts, dict):
        return "extras: the options must be an object"
    for k, v in opts.items():
        if k not in OPTION_DEFAULTS:
            return f"extras: unknown option {str(k)[:40]!r}"
        if k == "charge_limit" and v is not None and not _limit_ok(v):
            return f"the charge limit must be a whole number from {CHARGE_MIN} to {CHARGE_MAX} %"
        if k == "charge_behaviour" and v == "inhibit-charge":
            return "inhibit-charge is never set: it stops charging while asleep too and can leave a flat battery"
        if k == "charge_behaviour" and v is not None and v not in BEHAVIOURS:
            return f"the charge behaviour must be auto or inhibit-charge-awake, not {str(v)[:40]!r}"
        if k == "lpmd_game_off" and not isinstance(v, bool):
            return "lpmd_game_off must be true or false"
        if k in ("charge_limit", "charge_behaviour") and v is not None and not g["battery"]:
            return g["why"] or "no battery charge control was found"
        if k == "charge_limit" and v is not None and not g.get("limit_file"):
            return "the battery has no charge limit control"
        if k == "charge_behaviour" and v is not None and v not in words:
            return f"the battery does not offer {v}"
    return None


def set_options(ctx, opts) -> dict:
    """opts: {charge_limit?, charge_behaviour?, lpmd_game_off?} → ExtrasInfoRes. Validates, saves and writes the
    charge values at once; nothing is saved or written when anything is refused."""
    try:
        with _LOCK:
            st = _get(ctx)
            g = _gates(ctx, st)
            g = dict(g, battery=g["battery"] if g["board_ok"] else None)
            g["limit_file"] = _charge_file(g, "limit")
            beh = _charge_file(g, "behaviour")
            why = _check_opts(opts, g, _bracketed(_read(beh))[1] if beh else [])
            if why:
                return _answer(ctx, st, False, why)
            new = dict(st.opts, **opts)
            changed = [k for k in opts if opts[k] != st.opts[k]]
            err = st.store.replace(dict(new, version=VERSION))
            st.opts = _norm_opts(new)
            ch = st.run["charge"]
            did: list = []
            for which, (opt, _f) in _CHARGE.items():
                if opt in changed:
                    ch["overridden"][which] = None
                    ch[which] = None
            error = None
            if any(k in changed for k in ("charge_limit", "charge_behaviour")) and g["battery"]:
                error = _charge_apply(ctx, st, g, did)
                st.charge_checked = _monotonic()
            _save_run(ctx, st)
            if err:
                error = error or err
            return _answer(ctx, st, error is None, error)
    except Exception as e:
        log.exception("extras: set_options")
        return {"ok": False, "error": f"extras: {type(e).__name__}: {e}", "extras": None}


def take_control(ctx, what) -> dict:
    """what: fan | scx | charge_limit | charge_behaviour: clears that override (and the fan's revert) and applies
    it at once (the fan and scx with the last active profile; main.py syncs right after too)."""
    try:
        with _LOCK:
            st = _get(ctx)
            if what not in WHATS:
                return _answer(ctx, st, False, f"extras: take control of what? {str(what)[:40]!r}")
            run, did = st.run, []
            now = _monotonic()
            error = None
            act = _norm_active(st.active)
            g = _gates(ctx, st)
            if what == "fan":
                run["fan"].update({"reverted": None, "overridden": None, "held": None, "key": None})
                if g["board_ok"]:
                    _fan_step(ctx, st, g, act, now, did)
                error = run["fan"]["reverted"]
            elif what == "scx":
                run["scx"].update({"overridden": None, "held": None})
                st.scx_retry_at = None
                _scx_step(ctx, st, act, now, did)
            else:
                which = "limit" if what == "charge_limit" else "behaviour"
                run["charge"]["overridden"][which] = None
                if g["board_ok"] and g["battery"]:
                    error = _charge_apply(ctx, st, g, did, only=which)
            _save_run(ctx, st)
            return _answer(ctx, st, error is None, error)
    except Exception as e:
        log.exception("extras: take_control")
        return {"ok": False, "error": f"extras: {type(e).__name__}: {e}", "extras": None}


def _steps(ctx, st: _St, act: dict, now: float, did: list, safety: bool) -> bool:
    g = _gates(ctx, st)
    if not g["board_ok"]:
        g = dict(g, ec=None, battery=None)
    if safety:
        _fan_safety(ctx, st, g, act, did)
    _fan_step(ctx, st, g, act, now, did)
    _scx_step(ctx, st, act, now, did)
    changed = _lpmd_step(ctx, st, act, now, did)
    if safety:
        _charge_step(ctx, st, g, now, did)
    return changed


def tick(ctx, active) -> dict:
    """One step of main.py's watch loop (every 2 s): fan safety, fan mode, scx mode, intel_lpmd, charge.
    {ok, error, did: [str], lpmd_changed}."""
    try:
        with _LOCK:
            st = _get(ctx)
            now = _monotonic()
            susp = _int(_read(ctx.sys_path(SUSPEND_SUCCESS)))
            gap = _clock_gap()
            if st.seen and ((susp is not None and st.prev_susp is not None and susp > st.prev_susp)
                            or (gap is not None and st.prev_gap is not None and gap - st.prev_gap > BOOTTIME_JUMP_S)):
                st.resumed_at = now
                st.charge_at = now + RESUME_DELAY_S
                if st.run["fan"]["ours"] is not None and not (st.slept and st.fan_again_at is not None):
                    st.slept, st.fan_again_at = True, now + RESUME_DELAY_S
                log.info("extras: resumed")
            st.seen, st.prev_susp, st.prev_gap = True, susp, gap
            if susp is not None:
                st.run["suspend_count"] = susp
            st.active = active
            did: list = []
            changed = _steps(ctx, st, _norm_active(active), now, did, safety=True)
            _save_run(ctx, st)
            return {"ok": True, "error": None, "did": did, "lpmd_changed": changed}
    except Exception as e:
        log.exception("extras: tick")
        return {"ok": False, "error": f"extras: {type(e).__name__}: {e}", "did": [], "lpmd_changed": False}


def sync(ctx, active) -> dict:
    """Right after a profile change: the fan mode, scx mode and intel_lpmd at once. As tick."""
    try:
        with _LOCK:
            st = _get(ctx)
            st.active = active
            did: list = []
            changed = _steps(ctx, st, _norm_active(active), _monotonic(), did, safety=False)
            _save_run(ctx, st)
            return {"ok": True, "error": None, "did": did, "lpmd_changed": changed}
    except Exception as e:
        log.exception("extras: sync")
        return {"ok": False, "error": f"extras: {type(e).__name__}: {e}", "did": [], "lpmd_changed": False}


def lpmd_paused(ctx) -> bool:
    """OXP3 Deck has intel_lpmd in LPM_FORCE_OFF now. Never takes the module lock (power.py calls it under its own)."""
    try:
        got = _PAUSED.get(ctx.settings_dir)
        if got is None:
            st = _STATES.get(ctx.settings_dir)
            if st is None:
                return _load_run(ctx)["lpmd"]["paused"]
            return bool(st.run["lpmd"]["paused"])
        return bool(got)
    except Exception:
        return False


def unload(ctx) -> None:
    """Fan back to Auto, the scheduler mode and intel_lpmd put back, the sleep watch stopped. The charge settings
    stay (the user's battery choice). Never raises; short timeouts (main.py allows 3 s)."""
    st = _STATES.get(ctx.settings_dir)
    if st is None:
        return
    try:
        _stop_watch(st)
        fan = st.run["fan"]
        if fan["ours"] is not None or st.slept:
            g = _gates(ctx, st)
            err = _fan_write(g, "auto") if g["board_ok"] else None
            if err:
                log.error("extras: unload: fan back to Auto failed: %s", err)
            fan["ours"] = None
            st.slept = False
    except Exception:
        log.exception("extras: unload: fan")
    got = _LOCK.acquire(timeout=1)
    try:
        if st.run["scx"]["before"] is not None:
            c = _scx_read(st, _monotonic(), force=True, timeout=UNLOAD_TIMEOUT_S)
            if c["sched"] == LAVD and (st.run["scx"]["ours"] is None or c["mode"] == st.run["scx"]["ours"]):
                _scx_restore(st, _monotonic(), UNLOAD_TIMEOUT_S, [])
        if st.run["lpmd"]["paused"]:
            _lpmd_restore(st.run["lpmd"], UNLOAD_TIMEOUT_S)
        _save_run(ctx, st)
    except Exception:
        log.exception("extras: unload")
    finally:
        if got:
            _LOCK.release()
    log.info("extras: unloaded")


def _reset() -> None:
    """Tests: forget every state (the sleep watches are stopped)."""
    with _LOCK:
        for st in _STATES.values():
            _stop_watch(st)
        _STATES.clear()
        _PAUSED.clear()

