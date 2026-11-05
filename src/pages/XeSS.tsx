// xess-xmx-linux: version, the driver check, the default Mesa driver, install / update / uninstall, the system
// Protons' hook, missing tools and old package folders.
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { FC, useMemo, useState } from "react";

import { blockedBy, installXess, uninstallXess, useAction } from "../actions";
import { get_overview, xess_check_update, xess_remove_folder, xess_set_driver, xess_shim_system_protons, xess_state } from "../backend";
import { confirm, DetailsSpec, paragraphs } from "../components/confirm";
import { Code, explain, INFO, Note, Problem, Status, WithDetails } from "../components/Hint";
import { JobView, TaskSection } from "../components/JobView";
import { driverPrefix } from "../launchopts";
import { invalidate, useCurrentJob, useResource } from "../store";
import { firstSentence, fitsOneLine } from "../text";
import type { Overview, XessDriver, XessStateRes, XessUpdateCheck } from "../types";
import { listText, toast } from "../util";
import { checkText, offerLabel, pieceText, repairText, xessOffer } from "../xessoffer";
import { xessLine } from "./Quick";

/** What switch-driver.sh is given: the major.minor prefix when it names one driver, else the full version. */
const prefixFor = (d: XessDriver, all: XessDriver[]) => {
  const p = driverPrefix(d.version);
  return all.filter((x) => driverPrefix(x.version) === p).length > 1 ? d.version : p;
};

const OldFolder: FC<{ path: string; disabled: boolean }> = ({ path, disabled }) => {
  const act = useAction();
  return (
    <>
      <ButtonItem layout="below" disabled={disabled || !!act.busy}
        onClick={() => act.run("remove", async () => {
          const ok = await confirm({ title: "Remove this folder?", ok: "Remove", destructive: true,
            text: <>Deletes <Code>{path}</Code>, an earlier xess-xmx-linux package nothing uses any more (the plugin checks that first).</> });
          if (!ok) return null;
          const r = await xess_remove_folder(path);
          if (r.ok) { toast("Old folder removed"); invalidate("xess"); }
          return r.ok ? null : r.error;
        })}
        description={explain(path.split("/").pop() ?? path)}>
        {act.busy ? "Removing…" : "Remove old folder"}
      </ButtonItem>
      <Problem what="Remove" error={act.error} />
    </>
  );
};

export const XessTab: FC = () => {
  const ov = useResource<Overview>("overview", get_overview);
  const xs = useResource<XessStateRes>("xess", xess_state, { fresh: true });
  const chk = useResource<XessUpdateCheck>("manual:xess-check", xess_check_update, { skip: true });
  const job = useCurrentJob();
  const running = job?.state === "running";
  const inst = useAction();
  const drv = useAction();
  const shim = useAction();
  const [drvRev, setDrvRev] = useState(0);   // remounts the dropdown when the pick did not happen
  const [shimNotes, setShimNotes] = useState<string[]>([]);
  const x = xs.data?.ok ? xs.data.xess : null;
  const drivers = x?.drivers ?? [];
  const current = drivers.find((d) => d.default) ?? null;
  const driverOpts = useMemo(() => drivers.map((d) => ({ data: d.version, label: `Mesa ${d.version}` })), [drivers.map((d) => d.version).join(",")]);
  // without xess_state the overview's summary says what is installed (FE-4); only a newer tag is an update (FE-1)
  const sum = ov.data?.ok ? ov.data.xess : null;
  const installed = x ? x.installed : !!sum?.installed;
  const version = x ? x.version : sum?.version ?? null;
  const offer = xessOffer(installed, version, x, chk.data);
  const user = ov.data?.ok ? ov.data.user : null;
  // the state read for this tab is newer than the overview's summary
  const line = xessLine(x ? { installed: x.installed, version: x.version, status: x.status.state, line: x.status.line,
    live: x.live, relogin_needed: x.relogin_needed } : ov.data?.ok ? ov.data.xess : null);
  const unshimmed = (x?.system_protons ?? []).filter((p) => !p.shimmed);
  const busy = running || !!inst.busy;
  const drvD: DetailsSpec | null = x ? { title: "Default graphics driver", body: `The package's fast driver every game uses unless its own settings pick another. Applies at each game's next start; no re-login.${x.preferred_driver ? ` Kept across updates: ${x.preferred_driver}.` : ""}`, lines: ["tools/switch-driver.sh", "per game: MESA=…"] } : null;

  return (
    <>
      <TaskSection />
      <PanelSection title="XeSS fast mode">
        <PanelSectionRow>
          {!xs.data && <Status ok={null} label="Reading…" />}
          <Problem what="XeSS state" error={xs.data && !xs.data.ok ? xs.data.error : null} />
          <Status ok={line.ok} label={line.label} detail={line.detail} details={{
            title: "XeSS fast mode", body: paragraphs([line.more, x && !x.installed && x.package_dir ? "The package OXP3 Deck installed last is no longer set up (uninstalled). Install sets it up again." : null,
              x?.installed ? (x.managed ? "Installed by OXP3 Deck." : "Installed by hand; Update moves it to a folder OXP3 Deck manages.") : null]),
            lines: x ? [...(x.package_dir ? [`package: ${x.package_dir}`] : []), `driver check at log-in: ${x.units.check ?? "not set up"}`, `prefix watcher: ${x.units.watcher ?? "not set up"}`] : undefined,
          }} />
          {x?.script_running && (
            <Status ok={null} label="Installer still running" detail="Buttons wait until it ends."
              details={{ title: "Installer still running", body: "A package script started before the plugin restarted (a Decky or plugin update) and runs to its end. Install, Uninstall, the driver switch, the add-on and removing old folders wait until it has ended; open this page again then.", lines: [x.script_running] }} />
          )}
          {x?.installed && (
            <Status ok={x.status.state === "ok" ? true : x.status.state === "failed" ? false : null}
              label={`Driver check: ${x.status.state === "ok" ? "OK" : x.status.state === "failed" ? "Failed" : "Not run yet"}`}
              detail={x.status.state === "failed" ? "Games use the slower mode." : x.status.driver ?? undefined}
              details={{ title: "Driver check", body: paragraphs(["Checks at each log-in that the fast driver works; if not, games fall back to the slower mode.", ...(x.status.notes ?? [])]),
                lines: x.status.line ? [x.status.line] : undefined }} />
          )}
          {x?.flatpak_steam && (
            <Status ok={false} label="Steam is a Flatpak" detail="Not supported: needs Steam from system packages."
              details={{ title: "Steam is a Flatpak", body: "XeSS fast mode works with Steam installed from the system's packages; the Flatpak's graphics driver and Protons are separate." }} />
          )}
          {!!x?.missing_tools?.length && (
            <Status ok={false} label={`Missing programs: ${listText(x.missing_tools)}`} detail="Install them first."
              details={{ title: "Missing programs", body: "The installer needs these programs; install them with the system's package manager first.", lines: x.missing_tools }} />
          )}
          {x?.installed && !!x.missing_downloads?.length && (
            <Status ok={false} label="Some parts didn't download" detail={x.repair ? "Repair downloads them." : "The next update downloads them."}
              details={{ title: "Some parts didn't download", body: paragraphs([...x.missing_downloads.map((p) => pieceText(p)),
                x.repair ? "Repair (below) runs the installer again, which downloads them." : "The installer downloads them when it runs again (the next update)."]),
                lines: x.missing_downloads.map((p) => `${p}/`) }} />
          )}
        </PanelSectionRow>
        <PanelSectionRow>
          {offer.kind && (
            <WithDetails details={{ title: offerLabel(offer), body: offer.kind === "update" ? `Updates ${version ?? ""} to ${offer.latest} in a new folder; the old one is uninstalled first. Then log out and back in; asks first.`
              : offer.kind === "repair" ? `${repairText(offer)} Asks first.` : "Downloads the newest release of xess-xmx-linux and runs its installer as your user. Then log out and back in; asks first." }}>
              <ButtonItem layout="below" disabled={busy || !xs.data || (!x && !sum)}
                onClick={() => inst.run("install", async () => blockedBy() ?? installXess(offer, x, user))}
                description={explain(offer.kind === "repair" ? "Runs the installer again." : "Faster XeSS upscaling and frame generation in games.")}>
                {inst.busy === "install" ? "Working…" : `${offerLabel(offer)}${INFO}`}
              </ButtonItem>
            </WithDetails>
          )}
          <ButtonItem layout="below" disabled={busy || chk.loading}
            onClick={() => inst.run("check", async () => { const r = await chk.reload(); return r && !r.ok ? r.error : null; })}
            description={explain(chk.data?.ok ? firstSentence(checkText(chk.data, installed, version)) : "Changes nothing.")}>
            {chk.loading ? "Checking…" : "Check for an update"}
          </ButtonItem>
          {x?.installed && (
            <WithDetails details={{ title: "Uninstall", body: "Runs the package's uninstaller as your user; the folder stays. Log out and back in afterwards; asks first." }}>
              <ButtonItem layout="below" disabled={busy}
                onClick={() => inst.run("uninstall", async () => blockedBy() ?? uninstallXess(x))}
                description={explain("Log out and back in afterwards.")}>
                {inst.busy === "uninstall" ? "Working…" : `Uninstall${INFO}`}
              </ButtonItem>
            </WithDetails>
          )}
          <Problem what="xess-xmx-linux" error={inst.error} />
        </PanelSectionRow>
        {inst.job && <JobView job={inst.job} lines={6} />}
      </PanelSection>
      {x?.installed && drivers.length > 0 && (
        <PanelSection title="Default driver">
          <PanelSectionRow>
            <WithDetails details={drvD}>
            <DropdownItem key={`drv-${current?.version ?? ""}-${drivers.length}-${drvRev}`} label={`Default graphics driver${INFO}`} menuLabel="Default graphics driver"
              layout="below" childrenContainerWidth="max" bottomSeparator="none" disabled={running || !!drv.busy}
              rgOptions={driverOpts} selectedOption={current?.version ?? null}
              onChange={(o) => drv.run("driver", async () => {
                const d = drivers.find((v) => v.version === o.data);
                if (!d || d.default) return null;
                const ok = await confirm({ title: `Make Mesa ${d.version} the default?`, ok: "Switch",
                  text: `switch-driver.sh tests the driver first, then every game without MESA=… in its launch options uses it from its next start. No re-login needed; OXP3 Deck sets it again after an update.` });
                if (!ok) { setDrvRev((n) => n + 1); return null; }
                const r = await xess_set_driver(prefixFor(d, drivers));
                if (r.ok) toast(`Default driver: Mesa ${d.version}. Applies at each game's next start.`);
                else setDrvRev((n) => n + 1);
                invalidate("xess");
                return r.ok ? null : r.error;
              })}
              description={explain("Used by every game unless it picks its own.")} />
            </WithDetails>
            {drv.busy && <Status ok={null} label="Testing and switching the driver…" />}
            <Problem what="Default driver" error={drv.error} />
          </PanelSectionRow>
        </PanelSection>
      )}
      {x?.installed && (
        <PanelSection title="Protons">
          <PanelSectionRow>
            {(x.system_protons ?? []).map((p) => (
              <Status key={p.path} ok={p.shimmed} label={p.name}
                detail={p.shimmed ? "XeSS fast mode ready" : "Needs the XeSS add-on"} />
            ))}
            {unshimmed.length > 0 && (
              <ButtonItem layout="below" disabled={running || !!shim.busy}
                onClick={() => shim.run("shim", async () => {
                  const ok = await confirm({ title: "Add the XMX shim to the system Protons?", ok: "Add",
                    text: <>Copies the package's igdext64.dll into {listText(unshimmed.map((p) => p.name))} (keeping
                      the original as igdext64.dll.stock), as install.sh asks for these read-only folders. A package update of these Protons
                      brings the stock file back; tap this again then.</> });
                  if (!ok) return null;
                  const r = await xess_shim_system_protons();
                  invalidate("xess");
                  setShimNotes(r.notes ?? []);
                  if (r.ok && r.done?.length) toast(`Shim added to ${r.done.length} system Proton${r.done.length === 1 ? "" : "s"}`);
                  return r.ok ? (r.failed?.length ? `not done: ${listText(r.failed)}` : null) : r.error;
                })}
                description={explain("Lets games on these Protons use fast mode.")}>
                {shim.busy ? "Working…" : `Add XeSS to system Protons (${unshimmed.length})`}
              </ButtonItem>
            )}
            {x.system_protons_need_shim && (
              <Status ok={false} label="A Proton update removed XeSS" detail="Add it again above."
                details={{ title: "A Proton update removed XeSS", body: "A package update of a system Proton put its stock file back. Add the XeSS add-on again with the button above.", lines: ["igdext64.dll"] }} />
            )}
            <Problem what="System Protons" error={shim.error} />
            {shimNotes.map((n, i) => <Note key={i} details={fitsOneLine(n) ? null : { title: "Note", body: n }}>{firstSentence(n)}</Note>)}
            {(x.user_protons ?? []).length > 0 && (
              <Note label="Your Protons" details={{ title: "Your Protons", body: "Protons in your own Steam folder, as the installer set them up.",
                lines: (x.user_protons ?? []).map((p) => `${p.name}: ${p.shimmed ? "shim" : "no shim"}, ${p.hook ? "hook" : "no hook"}`) }}>
                {`${(x.user_protons ?? []).filter((p) => p.shimmed).length} of ${(x.user_protons ?? []).length} ready for fast mode`}
              </Note>
            )}
          </PanelSectionRow>
        </PanelSection>
      )}
      {x && (x.old_folders.length > 0 || (x.old_folders_kept ?? []).length > 0) && (
        <PanelSection title="Old XeSS folders">
          <PanelSectionRow>
            <Note>Remove old versions to free space.</Note>
            {x.relogin_needed && x.old_folders.length > 0 && <Note>Log out and back in first.</Note>}
            {/* RC-2: the ones xess_remove_folder always refuses get no Remove button */}
            {(x.old_folders_kept ?? []).map((k) => (
              <Note key={k.path} label="Left to you" details={{ title: "Left to you", body: `This folder ${k.why}.`, lines: [k.path] }}>{k.path.split("/").pop()}</Note>
            ))}
          </PanelSectionRow>
          {x.old_folders.map((p) => <PanelSectionRow key={p}><OldFolder path={p} disabled={running || x.relogin_needed} /></PanelSectionRow>)}
        </PanelSection>
      )}
    </>
  );
};
