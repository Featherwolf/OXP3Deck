// An error boundary (ROADMAP N-3): a section whose rows throw while rendering shows one red row, "This section hit
// an error", with Retry (draws the section again) and Copy details, instead of taking the whole panel or page with it.
// Around every Quick Access group's rows, the quick panel itself, every tab of the full page and the page itself.
// Our own class: @decky/ui's ErrorBoundary is Steam's, found at run time, and may be missing.
import { PanelSection, PanelSectionRow } from "@decky/ui";
import { Component, ErrorInfo, ReactNode } from "react";

import { CRASH_LABEL, crashLine, crashText } from "../boundary";
import { RetryCopy, Status } from "./Hint";

type Props = {
  /** The section's name, in the Details and the copied text. */
  what: string;
  /** How the red row is wrapped: in a PanelSectionRow (default, inside a group), a PanelSection, or as it is. */
  wrap?: "row" | "section" | "none";
  children?: ReactNode;
};
type State = { failed: boolean; error: unknown; stack: string | null };

export class Boundary extends Component<Props, State> {
  state: State = { failed: false, error: null, stack: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ stack: info?.componentStack ?? null });
    try { console.error(`OXP3 Deck: ${this.props.what} failed to render`, error); } catch { /* no console */ }
  }

  /** Mount the section again (its rows were unmounted when it failed). */
  retry = () => this.setState({ failed: false, error: null, stack: null });

  render() {
    if (!this.state.failed) return this.props.children ?? null;
    const { what, wrap = "row" } = this.props;
    const { error, stack } = this.state;
    const text = crashText(what, error, stack);
    const rows = (
      <>
        <Status ok={false} red label={CRASH_LABEL} detail={crashLine(error)}
          details={{ title: `${what}: ${CRASH_LABEL.toLowerCase()}`,
            body: "A bug in OXP3 Deck stopped this part from showing; the rest still works. Retry draws it again. Copy details copies the error for a bug report.",
            lines: text.split("\n").slice(1, 8), linesTitle: "Technical:" }} />
        <RetryCopy copy={text} onRetry={this.retry} copyLabel="Copy details" />
      </>
    );
    return wrap === "none" ? rows
      : wrap === "section" ? <PanelSection><PanelSectionRow>{rows}</PanelSectionRow></PanelSection>
      : <PanelSectionRow>{rows}</PanelSectionRow>;
  }
}
