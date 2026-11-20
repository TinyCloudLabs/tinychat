// The desktop app's "Record this call" tile (src/callPrompt), in each phase that shows something, over a scripted
// bridge. The real tile is its own transparent window docked at the right edge of the screen, over the call (about
// 200x150 for the offer, 180x52 for the recording bar): here it sits in a box of that size at the right edge of a dark
// stand-in for the call. Always the app's dark look, whatever the theme. The recording dot pulses unless the capture
// runs with reduced motion.
import { useEffect, useRef } from "react";
import { mountCallPromptTile, type CallPromptPhase } from "@/callPrompt/tile";

interface TileState {
  phase: CallPromptPhase;
  elapsedMs?: number;
  paused?: boolean;
}
import "@/callPrompt/callPrompt.css";
import type { HarnessScreen } from "../screen";

function Tile({ state }: { state: TileState }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const tile = mountCallPromptTile(root.current, {
      invoke: async (command) => (command === "call_prompt_state" ? state : undefined),
      listen: async () => () => {},
    });
    return () => {
      tile.dispose();
      root.current?.replaceChildren();
    };
  }, [state]);
  const bar = state.phase === "recording" && state.elapsedMs !== undefined;
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#16171b" }}>
      <main
        ref={root}
        className="cp-root"
        style={{ position: "absolute", right: 8, top: "50%", width: bar ? 180 : 200, height: bar ? 52 : 150, transform: "translateY(-50%)" }}
      />
    </div>
  );
}

const screen = (name: string, state: TileState, readyWhen: string): HarnessScreen => ({
  id: `call-prompt-${name}`,
  group: "call-prompt",
  layout: "pane",
  displayTitle: false,
  // A macOS window: only the desktop sizes.
  viewports: ["desktop", "desktop-min"],
  readyWhen,
  render: () => <Tile state={state} />,
});

export const callPromptScreens: HarnessScreen[] = [
  screen("offered", { phase: "offered" }, ".cp-tile[data-phase=offered] .cp-start:not(:disabled)"),
  screen("starting", { phase: "starting" }, ".cp-tile[data-phase=starting] .cp-start:disabled"),
  // An older native side, which sends no time: the dot in the offer tile.
  screen("recording", { phase: "recording" }, ".cp-tile[data-phase=recording] .cp-dot"),
  screen("recording-bar", { phase: "recording", elapsedMs: 754_000, paused: false }, ".cp-bar[data-paused=false] .cp-stop"),
  screen("recording-paused", { phase: "recording", elapsedMs: 3_725_000, paused: true }, ".cp-bar[data-paused=true] .cp-stop"),
];
