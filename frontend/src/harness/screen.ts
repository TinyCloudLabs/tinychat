import type { ReactNode } from "react";

import type { AppPlatform } from "@/lib/platform";

/** One capture target of the exo-ui screenshot harness (test/exo-ui-screens.e2e.test.ts). */
export interface HarnessScreen {
  /** `<group>-<name>`, used in the URL (?screen=) and the file names. */
  id: string;
  /** The registry file it comes from (harness/screens/<group>.tsx); EXO_UI_ONLY filters on it. */
  group: string;
  /**
   * `pane`: an app surface inside the shell, pinned to the viewport (the
   * document must never scroll). `document`: a page that grows and is captured
   * whole, like the primitives gallery.
   */
  layout: "pane" | "document";
  /** Shows a Literata title, so the display font must have loaded. */
  displayTitle?: boolean;
  /** The router location it renders at. */
  path?: string;
  /** A selector scrolled into view (inside its pane) before the capture, for a part of a long page. */
  scrollTo?: string;
  /** Where it runs (default `web`). The phone app also gets the fake voice-notes plugin. */
  platform?: AppPlatform;
  /** The capture waits until this selector matches (an opened sheet, a loaded model), up to 5 s. */
  readyWhen?: string;
  render: () => ReactNode;
}
