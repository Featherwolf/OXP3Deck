// The variable-refresh row (DESIGN.md "Performance batch", A): whether to show it and its texts. The decision is
// oxp3-tool's (`status --json` refresh.vrr_safe); the plugin adds no VRR logic of its own. Pure, so node can test it
// (tests/js/perf.test.mjs).
import type { Oxp3Status } from "./types";

type Refresh = Oxp3Status["refresh"];

/** The `remember` key: the kernel the user hid the row on ("Don't show again"; a new kernel shows it again). */
export const VRR_TIP_KEY = "vrrTip";

export const VRR_LABEL = "Variable refresh is safe";
export const VRR_LINE = "Turn it on in Steam for smooth frames at any frame rate.";

/** The kernel token "Don't show again" stores (a kernel that could not be read: a fixed token, so hiding works). */
export const vrrKernelKey = (kernel: string | null | undefined): string => kernel || "unknown";

/**
 * Shown when oxp3-tool says variable refresh is safe (an older oxp3-tool: no key, not shown) and not hidden on this
 * kernel. Like oxp3-tool's own advice, not when the display firmware did not load (its DMC line is the advice then).
 */
export const vrrShown = (refresh: Refresh | null | undefined, kernel: string | null | undefined, hidden: string | null | undefined): boolean =>
  refresh?.vrr_safe === true && refresh?.vrr_reason !== "no_firmware" && !(hidden != null && hidden !== "" && hidden === vrrKernelKey(kernel));

/** oxp3-tool's own "Variable refresh (VRR) is safe" advice line (the Fixes tab shows the VRR row instead of it). */
export const isVrrAdvice = (line: string): boolean => /^Variable refresh \(VRR\) is safe/.test(line);

/** The dialog's paragraphs (body) and technical lines. */
export const vrrDetails = (refresh: Refresh | null | undefined): { body: string[]; lines: string[] } => {
  const why = (refresh?.vrr_why ?? "").trim().replace(/\.$/, "");
  const range = refresh?.vrr_range_hz;
  const min = Array.isArray(range) && range.length === 2 && range[0] > 0 ? Math.round(range[0]) : null;
  return {
    body: [
      `This kernel is safe for variable refresh${why ? `: ${why}` : ""}.`,
      "Turn it on in Steam: Settings > Display > Enable VRR. Some Steam versions also show it in Quick Access > Performance. \"Allow tearing\" is a separate switch and is not needed.",
      `With variable refresh on, a frame limit that does not divide 144 (40, 45, 50 fps) is smooth too. Set the limit a little below what the game holds steadily.${
        min != null ? ` Below ${min} fps the screen repeats frames, so keep the limit at ${min} fps or above.` : ""}`,
      "OLED screens can flicker slightly in dark scenes at low frame rates with variable refresh. If you see that, set a higher frame limit. (Not checked on this screen yet.)",
    ],
    lines: [...(refresh?.summary ?? []), ...(refresh?.vrr_reason ? [`vrr_reason: ${refresh.vrr_reason}`] : [])],
  };
};
