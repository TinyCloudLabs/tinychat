// A note's audio player (TC-761; moved from the Voice notes card's tests):
// Play audio, then how much of a long file has loaded, then the player.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MeetingAudioPlayerView, type PlayerState } from "./MeetingAudioPlayer";

const render = (state: PlayerState) => renderToStaticMarkup(<MeetingAudioPlayerView state={state} onPlay={() => {}} />);

describe("MeetingAudioPlayerView", () => {
  test("Play audio first; the file is read only when asked", () => {
    const html = render({ phase: "idle" });
    expect(html).toContain("Play audio");
    expect(html).not.toContain("<audio");
  });

  test("a long note shows how much of its audio has loaded", () => {
    const html = render({ phase: "loading", percent: 41 });
    expect(html).toContain("Loading audio… 41%");
    expect(html).toContain('role="status"');
    expect(html).not.toContain('data-testid="note-audio-player"');
    // The spinner holds still with reduced motion.
    expect(html).toContain("motion-safe:animate-spin");
  });

  test("loaded: the player, with the smoke script's test id", () => {
    const html = render({ phase: "ready", url: "blob:capacitor://localhost/0f1e" });
    expect(html).toContain('data-testid="note-audio-player"');
    expect(html).toContain('src="blob:capacitor://localhost/0f1e"');
  });

  test("a read that failed offers Try again; audio no longer stored says so", () => {
    expect(render({ phase: "failed" })).toContain("Try again");
    expect(render({ phase: "missing" })).toContain("The audio is no longer stored.");
  });
});
