// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Setup & updates: the hardware helper and each knob's state, oxp3-tool, update checks, the facts
 * for a problem report, the running task, and stored values from a newer OXP3 Deck (original
 * pages/Updates.tsx, FileRows.tsx; new for the hardware helper).
 */
import { Button, Callout, host, List, ListItem, Setting, type Element, type KnobStatus } from "@bathysphere/sdk";
import { hasCode } from "../core/errors";
import type { Stored } from "../core/storage";
import { clipBytes, details } from "../core/text";
import { info, onOxp3, platformLine } from "../device/info";
import { hw } from "../hw/knobs";
import { conflicts, power, profiles } from "../power/apply";
import { task } from "../power/selftest";
import { xess } from "../xess/detect";
import { helperRows, KNOB_NAME } from "./power";
import { Card, CopyCode, Status } from "./rows";
import { checkButton } from "./xess";
import { toolRows } from "./fixes";
import { oxp3 } from "../oxp3tool/state";

const REMOTES_FILE = "/usr/share/steamos-manager/remotes.d/50-oxp3-hw.toml";

function knobRow(k: KnobStatus): Element {
  const owner = k.owner === "self" ? "OXP3 Deck" : k.owner === "other" ? (k.lease ?? "another plugin") : k.owner === "steam" ? "Steam" : "nobody";
  const tone = !k.available ? "neutral" : k.overridden || k.lastReadBack === "mismatch" ? "bad" : k.owner === "other" ? "warn" : "good";
  const line = k.available ? `${owner} · ${k.backend}${k.overridden ? " · overridden" : ""}` : `Unavailable: ${k.reason ?? "?"}`;
  return (
    <ListItem
      label={KNOB_NAME[k.knob] ? `${k.knob}: ${KNOB_NAME[k.knob]}` : k.knob}
      description={line}
      tone={tone}
      details={details(k.knob, [`Backend: ${k.backend}`, `Owner: ${owner}`, k.lease ? `Lease: ${k.lease}` : null, k.lastReadBack ? `Last read-back: ${k.lastReadBack}` : null, k.reason ? `Reason: ${k.reason}` : null, k.owner === "other" ? "Held by another plugin: move the lease in Bathysphere Home → Hardware." : null])}
    />
  );
}

/** Is the oxp3-hw package installed (its steamos-manager remotes file)? */
async function packageSeen(): Promise<boolean | null> {
  try {
    await host.fs.system.stat(REMOTES_FILE);
    return true;
  } catch (e) {
    return hasCode(e, "ENOENT") ? false : null;
  }
}

/** The facts to paste into a problem report (≤ 4 KiB, a code node's limit). */
async function reportFacts(): Promise<string> {
  const p = await host.plugin.info().catch(() => null);
  const i = info.value;
  const s = hw.value;
  const facts = {
    oxp3deck: p?.version ?? "?",
    layers: p?.layers,
    device: i ? `${i.vendor} / ${i.product} / ${i.board}` : "?",
    os: i ? platformLine(i) : "?",
    provider: s?.state.provider ?? null,
    knobs: s?.state.knobs.filter((k) => k.available || k.reason).map((k) => `${k.knob}:${k.available ? k.owner : `-${k.reason ?? ""}`}${k.overridden ? ":overridden" : ""}`),
    conflicts: (conflicts.value ?? []).filter((c) => c.active).map((c) => c.id),
    power: { enabled: power.value.enabled, rule: profiles.value?.active.rule ?? null, failed: profiles.value?.active.failed.map((f) => `${f.knob}:${f.code}`) },
    xess: xess.value ? { installed: xess.value.installed, version: xess.value.version, status: xess.value.status.state, live: xess.value.live } : null,
    oxp3tool: oxp3.value ? { version: oxp3.value.toolVersion, fixes: Object.keys(oxp3.value.fixes) } : null,
  };
  return clipBytes(JSON.stringify(facts, null, 1), 4000);
}

/** Stored values from a newer OXP3 Deck, or damaged ones, are read-only until the user starts them fresh. */
function storedRows(stores: ReadonlyArray<Stored<unknown>>): Element[] {
  const out: Element[] = [];
  for (const st of stores) {
    if (st.readOnly) {
      out.push(
        <Callout title={`${st.title}: read-only`} tone="warn" text={st.readOnly} />,
        <Button
          label={`Start ${st.title.toLowerCase()} fresh`}
          variant="danger"
          onClick={async () => {
            const ok = await host.ui.confirm({ title: `Start ${st.title.toLowerCase()} fresh?`, body: "The stored value is deleted and this version starts from its defaults.", ok: "Start fresh", destructive: true });
            if (ok) await st.startFresh();
          }}
        />,
      );
    }
    if (st.writeError) out.push(<Status label={`${st.title}: not saved`} line={st.writeError} tone="bad" />);
  }
  return out;
}

export async function setupTab(stores: ReadonlyArray<Stored<unknown>>): Promise<Element[]> {
  const out: Element[] = [];
  const i = info.value;
  if (i) out.push(<Status label={`${i.product || i.board || "This device"}`} line={platformLine(i)} more={[`Vendor ${i.vendor || "?"}, product ${i.product || "?"}, board ${i.board || "?"}.`]} />);
  if (onOxp3()) {
    const s = hw.value;
    const seen = await packageSeen();
    const helper = helperRows(s);
    if (helper) out.push(helper);
    if (s?.state.provider) out.push(<Status label={`Hardware helper ${s.state.provider.name} ${s.state.provider.version}`} line={`State: ${s.state.provider.state} · device ${s.state.provider.device}`} tone={s.state.provider.state === "ok" ? "good" : "warn"} />);
    else if (seen) out.push(<Status label="oxp3-hw is installed but not running" line="Reboot once: its grants and Steam's setup apply at boot." tone="warn" />);
    out.push(<Card id="hw-stop" />);
    if (s) out.push(<List>{s.state.knobs.map(knobRow)}</List>);
    out.push(<Status label="Confirms" line="The first Quiet or Max fan, Run from charger and a limit below 80 % are confirmed once in Bathysphere Home." more="Bathysphere Home or the overlay asks once per plugin version. Inside Steam (Quick Access) the change waits until you make it once from Home." />);
    out.push(...toolRows(oxp3.value));
  }
  out.push(<Setting key="checkUpdates" />, ...checkButton());
  out.push(<Status label="Problem report" line="oxp3-tool collects the device's state; add these facts." more="The card saves an archive with logs (serials and addresses replaced). The text below is what OXP3 Deck knows; copy it into the report." />, <Card id="oxp3-tool-diagnose" />, <CopyCode text={await reportFacts()} />);
  if (task.title) out.push(<Status label={task.title} line={task.running ? "Running…" : "Done"} lines={task.log.slice(-32)} />);
  out.push(...storedRows(stores));
  return out;
}
