// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * oxp3-tool's fixes, button layout and kernel helper (original pages/Fixes.tsx, Buttons.tsx,
 * Kernel.tsx). oxp3-tool runs as root, so every action is a "Run this yourself" card with the exact
 * line beside it; the plugin reads oxp3-tool's state file afterwards to show what changed.
 */
import { Callout, Select, Slider, Text, TextField, Toggle, type Element } from "@bathysphere/sdk";
import { andList, details, fit } from "../core/text";
import { catalog, effectText, PINNED_VERSION, type Catalog } from "../oxp3tool/catalog";
import { applyLine, buttonsLine, revertLine, savedButtons, type ButtonChoice } from "../oxp3tool/commands";
import { fixState, oxp3, staleFixes, versionNewer, type Oxp3State } from "../oxp3tool/state";
import { updates } from "../updates/check";
import { Card, CopyCode, Status, Unread } from "./rows";
import { setState, stateOf, type View } from "./view";

const STATE_TEXT = { applied: "Applied", incomplete: "Not finished: apply again", reverting: "Undone: reboot to finish", none: "Not applied" } as const;

/** The do-not-reboot and reboot-to-finish rows (also in Quick Access Status). */
export function rebootRows(s: Oxp3State | undefined): Element[] {
  if (!s) return [];
  const out: Element[] = [];
  if (s.bootUnfinished) {
    out.push(
      <Callout title="Do not reboot yet" tone="bad" text={`oxp3-tool's last boot entry update did not finish, so the device may not start. ${s.bootCommand ? "Run this first:" : "The card says what to run first."}`} />,
      ...(s.bootCommand ? [<CopyCode text={`sudo ${s.bootCommand}`} />] : []),
      <Card id="boot-entries" />,
    );
  }
  if (s.rebootPending.length) {
    out.push(<Status label="Reboot to finish" line={`${andList(s.rebootPending)}: restart from Steam's power menu.`} tone="warn" more="Kernel arguments change only at boot. Bathysphere cannot reboot the device; use Steam's power menu." />);
  }
  return out;
}

/** oxp3-tool's version as far as the state file shows it, and the install card. */
export function toolRows(s: Oxp3State | undefined): Element[] {
  const latest = updates.value.oxp3;
  const have = s?.toolVersion ?? null;
  const out: Element[] = [];
  if (!have) {
    out.push(<Status label="oxp3-tool not seen yet" line="Install it, then apply its fixes; this page reads what it did." more={`Bathysphere cannot look into /usr/local/bin, so it knows oxp3-tool only from the fixes it applied (/var/lib/oxp3-tool/state.json). The card installs oxp3-tool ${PINNED_VERSION}, checked against its SHA-256.`} />);
  } else {
    const newer = [PINNED_VERSION, latest].filter((v): v is string => !!v && versionNewer(v, have));
    out.push(<Status label={`oxp3-tool ${have}`} line={newer.length ? `Version ${newer[newer.length - 1]} is available.` : "Up to date as far as OXP3 Deck knows."} tone={newer.length ? "warn" : "good"} more={["The version that applied the newest fix. OXP3 Deck needs 0.4.2 or newer.", latest ? `GitHub's newest: ${latest}.` : null]} />);
  }
  out.push(<Card id="oxp3-tool-install" />);
  if (s?.error) out.push(<Status label="oxp3-tool's state" line={s.error} tone="bad" />);
  return out;
}

/** Applied fixes from an older oxp3-tool: apply them again. */
export function staleRows(s: Oxp3State | undefined, c: Catalog | undefined): Element[] {
  if (!s || !c) return [];
  const ids = staleFixes(s).filter((id) => c.fixes.some((f) => f.id === id));
  if (!ids.length) return [];
  return [<Status label={`Apply again (${ids.length})`} line="Installed by an older oxp3-tool. Shows the plan first." tone="warn" />, <Card id="oxp3-tool-fix" steps={[0]} code={applyLine(c, ids)} />];
}

/** "7 applied · 2 need attention" for the closed Device fixes group. */
export function fixesSummary(s: Oxp3State | undefined): string {
  if (!s) return "Reading…";
  if (!s.present) return "oxp3-tool not seen yet";
  const states = Object.values(s.fixes).map(fixState);
  const applied = states.filter((x) => x === "applied").length;
  const attention = states.length - applied + (s.bootUnfinished ? 1 : 0);
  return fit([`${applied} applied`, attention ? `${attention} need attention` : null, updates.value.oxp3 && versionNewer(updates.value.oxp3, s.toolVersion) ? "Update available" : null].filter(Boolean).join(" · "));
}

/** The Fixes tab. */
export function fixesTab(v: View): Element[] {
  const s = oxp3.value;
  const c = catalog.value;
  const unread = !s && oxp3.error ? [<Unread what="oxp3-tool's state" error={oxp3.error} onRetry={() => oxp3.invalidate()} />] : [];
  const out: Element[] = [...unread, ...rebootRows(s), ...toolRows(s), <Card id="oxp3-tool-apply" />, ...staleRows(s, c)];
  if (!c) return [...out, <Text variant="muted" text="Reading the fix list…" />];
  out.push(<Card id="oxp3-tool-fix" />);
  for (const f of c.fixes) {
    const e = s?.fixes[f.id];
    const st = fixState(e);
    let line: string | null = null;
    if (st === "applied" || st === "incomplete") line = revertLine(c, f.id);
    if (st !== "applied") {
      if (f.id === "oled-profile") {
        const hz = stateOf(v, "minRefresh", c.minRefresh.default);
        out.push(<Slider label="Lowest refresh rate (OLED profile)" min={c.minRefresh.min} max={c.minRefresh.max} step={1} value={hz} valueLabel={`${hz} Hz`} onChange={(x) => setState(v, "minRefresh", x)} />);
        line = applyLine(c, [f.id], hz === c.minRefresh.default ? {} : { minRefresh: hz });
      } else if (f.id === "nvme-resume") {
        const any = stateOf(v, "anySsd", false);
        out.push(<Toggle label="Apply without the SSD the fix was made for" value={any} onChange={(x) => setState(v, "anySsd", x)} />);
        line = applyLine(c, [f.id], { anySsd: any });
      } else line = applyLine(c, [f.id]);
    }
    out.push(
      <Status
        label={fit(f.title)}
        line={`${STATE_TEXT[st]} · ${f.level} · works ${effectText(f)}`}
        tone={st === "applied" ? "good" : st === "none" ? "neutral" : "warn"}
        more={[f.summary, f.details, `Fix id: ${f.id}${f.karg ? ` (kernel argument ${f.karg})` : ""}`, "Whether oxp3-tool recommends it on this unit, and its notes, need root: sudo oxp3-tool status shows them."]}
      />,
    );
    if (line) out.push(<CopyCode text={line} />);
  }
  out.push(<Status label="Variable refresh" line="sudo oxp3-tool status says whether it is safe on this kernel." more="That verdict comes from xe module parameters and the display firmware, which Bathysphere cannot read." />);
  return out;
}

/** The Buttons tab: what each key does, the frame-limit value, the exact line. */
export function buttonsTab(v: View): Element[] {
  const c = catalog.value;
  if (!c) return [<Text variant="muted" text="Reading the fix list…" />];
  const s = oxp3.value;
  const saved = savedButtons(c, s?.fixes.buttons?.options);
  const b = stateOf<ButtonChoice>(v, "buttons", { ...saved, xboxHelper: s?.fixes["xbox-key"]?.appliedAt != null });
  const set = (change: Partial<ButtonChoice>) => setState(v, "buttons", { ...b, ...change, actions: { ...b.actions, ...(change.actions ?? {}) } });
  const out: Element[] = [<Status label={s?.fixes.buttons ? "Current layout: from the last apply" : "Layout not applied yet"} line="Pick what each key does; the line below applies it." />];
  for (const [key, spec] of Object.entries(c.buttonKeys)) {
    out.push(
      <Select
        label={fit(spec.label.replace(/\s*\(.*\)$/, ""), 60)}
        options={Object.keys(c.buttonActions).map((a) => ({ value: a, label: fit(a === spec.default ? `${a} (default)` : a, 60) }))}
        value={b.actions[key] ?? spec.default}
        onChange={(a) => set({ actions: { [key]: a } })}
        details={details(spec.label, [c.buttonActions[b.actions[key] ?? spec.default] ?? "", `Stock: ${spec.stock}.`])}
      />,
    );
  }
  if (Object.values(b.actions).includes("fps-limit")) {
    out.push(<Slider label="Frame limit of the fps-limit key" min={c.fpsLimit.min} max={c.fpsLimit.max} step={1} value={Math.min(c.fpsLimit.max, Math.max(c.fpsLimit.min, b.fpsLimit))} valueLabel={`${b.fpsLimit} fps`} onChange={(x) => set({ fpsLimit: x })} />);
  }
  out.push(
    <Toggle label="Also the Xbox key helper" description="For units whose Xbox key needs it (sudo oxp3-tool status says)." value={b.xboxHelper} onChange={(x) => set({ xboxHelper: x })} />,
    <Toggle label="Apply without restarting InputPlumber" description="The keys change at the next reboot." value={b.noRestart} onChange={(x) => set({ noRestart: x })} />,
    <Card id="oxp3-tool-buttons" code={buttonsLine(c, b)} />,
  );
  return out;
}

const PACKAGE = /^[a-z0-9][a-z0-9.+_-]{0,63}$/;

/** The Kernel tab (CachyOS with Limine): oxp3-tool's kernel commands. */
export function kernelTab(v: View): Element[] {
  const pkg = stateOf(v, "kernelPackage", "");
  return [
    <Status label="Try another kernel once" line="oxp3-tool boots it once; the current one stays the default." more="Listing the installed kernels and the next boot needs /boot and EFI variables, which Bathysphere cannot read: the card's first step lists them." />,
    <TextField label="Kernel package" value={pkg} placeholder="linux-cachyos-rc" onSubmit={(x) => setState(v, "kernelPackage", x.trim())} />,
    ...(pkg && PACKAGE.test(pkg) ? [<CopyCode text={`sudo oxp3-tool kernel try ${pkg}`} />] : pkg ? [<Status label="Not a package name" line="Letters, digits, dots, plus, _ and - only." tone="warn" />] : []),
    <Card id="oxp3-tool-kernel" />,
  ];
}
