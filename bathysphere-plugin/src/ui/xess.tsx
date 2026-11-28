// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * XeSS fast mode (xess-xmx-linux): whether it is installed and live, its driver check, units and
 * drivers, and the install, update, repair and uninstall steps as "Run this yourself" cards with the
 * exact lines beside them (original pages/XeSS.tsx, xessoffer.ts).
 */
import { Button, Select, Toggle, type Element } from "@bathysphere/sdk";
import { details, fit } from "../core/text";
import { info, isBazzite, isCachyOs, usesPacman } from "../device/info";
import { setOn, auto } from "../games/autosetup";
import { checkNow, checkRunning, updates } from "../updates/check";
import { installLines, removeFolderLine, repairLine, switchDriverLine, uninstallLine, updateLines } from "../xess/commands";
import { CHECK_UNIT, oldFolders, WATCH_PATH, xess, xessLine, xessRecord, type XessState } from "../xess/detect";
import { packageVersion, RELEASE_DRIVERS, releaseRows, tagNewer } from "../xess/releases";
import { Card, Status, Unread } from "./rows";

/** The update the daily check found, if newer than the installed release. */
export const xessUpdate = (x: XessState | undefined): string | null => {
  const latest = updates.value.xess;
  return x?.installed && latest && tagNewer(latest, x.version) ? latest : null;
};

/** The state row (label, one line, everything else in Details); a failed read with Retry. */
export function xessStateRow(x: XessState | undefined): Element {
  if (!x && xess.error) return <Unread what="XeSS fast mode" error={xess.error} onRetry={() => xess.invalidate()} />;
  const l = xessLine(x);
  return (
    <Status
      label={l.label}
      line={l.line}
      tone={l.tone}
      more={[
        "Fast mode runs XeSS upscaling and frame generation on the GPU's XMX cores (xess-xmx-linux) instead of the slower DP4a path.",
        x?.path ? `Package: ${x.path} (found through ${x.how === "env" ? "the session environment file" : "the driver check unit"}).` : null,
        x?.status.line ? `Driver check: ${x.status.line}` : null,
        ...(x?.status.notes ?? []).map((n) => `Note: ${n}`),
        x?.steamVk === undefined ? "Steam is not running, so whether it uses the fast driver is not known." : null,
      ]}
    />
  );
}

/** Install, update or repair: what the user can do next (also in Quick Access). */
export function xessOffer(x: XessState | undefined): Element[] {
  if (!x) return [];
  const latest = updates.value.xess;
  if (!x.installed) {
    const lines = latest ? installLines(latest) : null;
    return [...toolsCard(), <Card id="xess-install" code={lines} />, ...(latest ? [] : [<Status label="Newest release not known yet" line="Check for an update to fill in the exact lines." />])];
  }
  const out: Element[] = [];
  const up = xessUpdate(x);
  if (up && x.path) out.push(<Status label={`Update to ${up}`} line={`Installed: ${x.version ?? "unknown"}.`} tone="warn" />, <Card id="xess-update" code={updateLines(x.path, up)} />);
  if (x.repair && x.path) out.push(<Status label="Repair XeSS fast mode" line={x.repair} tone="bad" more="Runs the installed release's install.sh again in its folder: it downloads only what is missing and sets up the driver setting, the add-on and its services again. Nothing is uninstalled." />, <Card id="xess-manage" steps={[0, 4]} code={repairLine(x.path)} />);
  if (x.relogin) out.push(<Status label="Log out of Game Mode and back in" line="Steam still runs with the old driver setting." tone="warn" more="Log out of Game Mode and back in (or reboot) so Steam starts with the new driver. After a failed driver check, reboot: the check runs again only at boot." />);
  return out;
}

/** The programs the installer needs: pacman's or rpm-ostree's card, else the list (original xess.py _how_to_get). */
function toolsCard(): Element[] {
  if (usesPacman(info.value)) return [<Card id="xess-tools" />];
  if (isBazzite(info.value)) return [<Card id="xess-tools-bazzite" />];
  return [<Status label="Programs the installer needs" line="curl, binutils, tar, zstd, coreutils, diffutils, python and unzip." more="Install them with your system's package manager; vulkan-tools (vulkaninfo) is optional. OXP3 Deck has the exact lines for CachyOS and Bazzite only." />];
}

/** "Check for an update" (needs the checkUpdates setting). */
export function checkButton(): Element[] {
  const u = updates.value;
  const busy = checkRunning();
  return [
    <Button
      label="Check for updates now"
      icon="refresh"
      disabled={busy}
      // the check runs on after the handler: three requests can take longer than a UI event may
      onClick={() => void checkNow()}
      details={details("Check for updates", ["Asks GitHub for the newest xess-xmx-linux release and oxp3-tool version. Needs \"Check daily for oxp3-tool and XeSS updates\" on: with it off, no request can leave the device."])}
    />,
    ...(busy ? [<Status label="Update check" line="Checking…" />] : u.error ? [<Status label="Update check" line={u.error} tone="warn" />] : u.lastOk !== null ? [<Status label="Last update check" line={`xess-xmx-linux ${u.xess ?? "?"} · oxp3-tool ${u.oxp3 ?? "?"}`} />] : []),
  ];
}

/** The switch for automatic setup (also on the Games tab). */
export function autoSwitch(): Element {
  return (
    <Toggle
      label="Set up games automatically"
      description={auto.value.on ? "OXP3 Deck sets up games after you quit them. Undo any time." : "Off: you set up each game yourself."}
      value={auto.value.on}
      onChange={async (on) => void (await setOn(on))}
    />
  );
}

/** The whole XeSS tab. */
export function xessTab(): Element[] {
  const x = xess.value;
  const out: Element[] = [xessStateRow(x), ...xessOffer(x), ...checkButton()];
  if (!x) return out;
  if (x.installed && x.path) {
    const check = x.units[CHECK_UNIT];
    const watch = x.units[WATCH_PATH];
    out.push(
      <Status label="Driver check" line={x.status.state === "ok" ? `Passed (${x.status.date ?? "?"})` : x.status.state === "failed" ? `FAILED: ${x.status.reason ?? "?"}` : "Not run yet"} tone={x.status.state === "failed" ? "bad" : "neutral"} more={[x.status.line, x.compileLog ? `Compile log (end):\n${x.compileLog}` : null]} />,
      <Status label="Services" line={`Driver check ${check?.file || check?.load || "?"} · watcher ${watch?.active ?? "?"}`} more={["xess-xmx-check.service checks the driver before each session; xess-xmx-shim.path adds the add-on to new Protons."]} />,
    );
    const drivers = [...new Set([...(RELEASE_DRIVERS[x.version ?? ""] ?? []), ...(x.status.driver ? [x.status.driver] : [])])];
    const pref = xessRecord.value.preferredDriver;
    if (drivers.length) {
      out.push(
        <Select
          label="Default driver for every game"
          options={[{ value: "", label: `As the release sets it${x.status.driver ? ` (Mesa ${x.status.driver})` : ""}` }, ...drivers.map((d) => ({ value: d, label: `Mesa ${d}` }))]}
          value={pref && drivers.includes(pref) ? pref : ""}
          onChange={async (d) => void (await xessRecord.save({ ...xessRecord.value, preferredDriver: d || null }))}
          details={details("Default driver", "tools/switch-driver.sh makes another patched Mesa driver the default for every game. A game can still pick one with MESA= (Games tab). The choice is remembered here, so the line is shown again after an update.")}
        />,
      );
      if (pref) out.push(<Card id="xess-manage" steps={[1, 4]} code={switchDriverLine(x.path, pref)} />);
    }
    out.push(<Card id="xess-manage" steps={[2, 4]} code={uninstallLine(x.path)} />);
    // proton-cachyos (the driver store bug's Proton) comes with CachyOS
    for (const r of releaseRows(x.version, isCachyOs(info.value))) out.push(<Status label={r.label} line={r.line} tone="warn" more={r.detail} />);
  }
  for (const old of oldFolders(x)) {
    const line = removeFolderLine(old);
    out.push(
      line && x.relogin === false
        ? <Status label={`Old release ${packageVersion(old) ?? ""}: nothing uses it`} line={fit(old)} more="Remove it after you logged out and back in." />
        : <Status label="Older folder" line={fit(old)} more="Not named like a release, or Steam may still use it: left to you." />,
    );
    if (line && x.relogin === false) out.push(<Card id="xess-manage" steps={[3]} code={line} />);
  }
  out.push(
    <Status label="Games on a system Proton stay on DP4a" line="proton-cachyos cannot carry the XeSS add-on; use GE-Proton." more="The original OXP3 Deck could put the add-on into system Protons as root. Bathysphere never does root work, so games need a Proton the installer can add it to (GE-Proton or Proton Experimental)." />,
    <Card id="ge-proton" />,
    autoSwitch(),
  );
  return out;
}
