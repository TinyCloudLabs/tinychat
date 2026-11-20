// The desktop app's "Record this call" tile (src/callPrompt), in each phase that shows something, over a scripted
// bridge. The real tile is its own 200x150 transparent window docked at the right edge of the screen, over the call:
// here it sits in a box of that size at the right edge of a dark stand-in for the call. Always the app's dark look,
// whatever the theme.
import { useEffect, useRef } from "react";
import { mountCallPromptTile, type CallPromptPhase } from "@/callPrompt/tile";
import "@/callPrompt/callPrompt.css";
import type { HarnessScreen } from "../screen";

function Tile({ phase }: { phase: CallPromptPhase }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const tile = mountCallPromptTile(root.current, {
      invoke: async (command) => (command === "call_prompt_state" ? { phase } : undefined),
      listen: async () => () => {},
    });
    return () => {
      tile.dispose();
      root.current?.replaceChildren();
    };
  }, [phase]);
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#16171b" }}>
      <main
        ref={root}
        className="cp-root"
        style={{ position: "absolute", right: 8, top: "50%", width: 200, height: 150, transform: "translateY(-50%)" }}
      />
    </div>
  );
}

const screen = (phase: CallPromptPhase, readyWhen: string): HarnessScreen => ({
  id: `call-prompt-${phase}`,
  group: "call-prompt",
  layout: "pane",
  displayTitle: false,
  // A macOS window: only the desktop sizes.
  viewports: ["desktop", "desktop-min"],
  readyWhen,
  render: () => <Tile phase={phase} />,
});

export const callPromptScreens: HarnessScreen[] = [
  screen("offered", ".cp-tile[data-phase=offered] .cp-start:not(:disabled)"),
  screen("starting", ".cp-tile[data-phase=starting] .cp-start:disabled"),
  screen("recording", ".cp-tile[data-phase=recording] .cp-dot"),
];
