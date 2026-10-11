// A note's audio player (TC-761; moved from the Voice notes card's tests):
// Play audio, then how much of a long file has loaded, then the player.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { installDom } from "@/test/dom";
import { playbackDuration, scrubTarget } from "./audioPlayback";
import { MeetingAudioPlayer, MeetingAudioPlayerView, stateForResolvedUrl, type PlayerState } from "./MeetingAudioPlayer";

const render = (state: PlayerState, durationSecs?: number | null) => renderToStaticMarkup(<MeetingAudioPlayerView state={state} onPlay={() => {}} durationSecs={durationSecs} />);

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

  test("a local URL that could not be resolved shows the real reason, with Try again", () => {
    const html = render({ phase: "failed", reason: "Could not open this phone's audio: the file is gone" });
    expect(html).toContain("Could not open this phone&#x27;s audio: the file is gone");
    expect(html).not.toContain("Couldn");
    expect(html).toContain("Try again");
  });

  test("a local URL is resolved into the player as it is, and a rejection becomes its reason", async () => {
    expect(await stateForResolvedUrl(async () => "capacitor://localhost/_capacitor_file_/a.m4a")).toEqual({
      phase: "ready",
      url: "capacitor://localhost/_capacitor_file_/a.m4a",
    });
    expect(await stateForResolvedUrl(async () => { throw new Error("tombstoned"); })).toEqual({ phase: "failed", reason: "tombstoned" });
  });
});

describe("the ready player's length", () => {
  test("shows the saved length before anything has loaded, with the scrubber held until the media answers", () => {
    const html = render({ phase: "ready", url: "capacitor://localhost/_capacitor_file_/a.m4a" }, 42);
    expect(html).toContain("0:00 / 0:42");
    expect(html).not.toContain("00:00");
    expect(html).toContain("Loading audio…");
    expect(html).toMatch(/<input[^>]*type="range"[^>]*max="42"[^>]*disabled/);
    expect(html).not.toMatch(/<audio[^>]*controls/);
  });

  test("with no saved length it says Loading… rather than 0:00 / 0:00", () => {
    const html = render({ phase: "ready", url: "blob:x" }, null);
    expect(html).toContain("Loading…");
    expect(html).not.toContain("0:00 / 0:00");
  });

  test("the media's length wins once it is real; Infinity, NaN and 0 fall back to the saved one", () => {
    expect(playbackDuration(42, 41.8)).toBe(41.8);
    expect(playbackDuration(42, Infinity)).toBe(42);
    expect(playbackDuration(42, NaN)).toBe(42);
    expect(playbackDuration(42, 0)).toBe(42);
    expect(playbackDuration(null, Infinity)).toBeNull();
    expect(playbackDuration(undefined, NaN)).toBeNull();
    expect(playbackDuration(0, 0)).toBeNull();
  });

  test("a scrubber value stays inside the clip", () => {
    expect(scrubTarget(12.5, 42)).toBe(12.5);
    expect(scrubTarget(99, 42)).toBe(42);
    expect(scrubTarget(-3, 42)).toBe(0);
    expect(scrubTarget(NaN, 42)).toBe(0);
    expect(scrubTarget(7, null)).toBe(7);
  });
});

describe("the ready player in a DOM", () => {
  let cleanupDom: (() => void) | undefined;
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    cleanupDom?.();
    cleanupDom = undefined;
  });

  const mount = async (props: { durationSecs?: number | null; onError?: () => void; onPlayingChange?: (playing: boolean) => void }) => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<MeetingAudioPlayerView state={{ phase: "ready", url: "blob:note" }} onPlay={() => {}} {...props} />));
    const audio = host.querySelector("audio") as HTMLAudioElement;
    const fake: { duration: number; currentTime: number; paused: boolean; played: number; paused_: number } = { duration: NaN, currentTime: 0, paused: true, played: 0, paused_: 0 };
    Object.defineProperty(audio, "duration", { get: () => fake.duration });
    Object.defineProperty(audio, "currentTime", { get: () => fake.currentTime, set: (value: number) => { fake.currentTime = value; } });
    Object.defineProperty(audio, "paused", { get: () => fake.paused });
    audio.play = () => { fake.played++; fake.paused = false; return Promise.resolve(); };
    audio.pause = () => { fake.paused_++; fake.paused = true; };
    const fire = (type: string) => act(async () => { audio.dispatchEvent(new Event(type)); });
    const time = () => host.querySelector("[data-testid=note-audio-time]")!.textContent;
    const range = () => host.querySelector("input[type=range]") as HTMLInputElement;
    const toggle = () => host.querySelector("[data-testid=note-audio-toggle]") as HTMLButtonElement;
    return { host, audio, fake, fire, time, range, toggle };
  };

  test("loading, then ready: the saved length shows throughout and the scrubber opens on metadata", async () => {
    const player = await mount({ durationSecs: 42 });
    expect(player.time()).toBe("0:00 / 0:42");
    expect(player.range().disabled).toBe(true);
    expect(player.host.querySelector("[role=status]")?.textContent).toBe("Loading audio…");

    player.fake.duration = Infinity;
    await player.fire("loadedmetadata");
    expect(player.time()).toBe("0:00 / 0:42");
    expect(player.range().disabled).toBe(false);
    expect(player.range().max).toBe("42");
    expect(player.host.querySelector("[role=status]")).toBeNull();

    player.fake.duration = 41.6;
    await player.fire("durationchange");
    expect(player.time()).toBe("0:00 / 0:42");
    expect(player.range().max).toBe("41.6");
  });

  test("a stream that never reports a length keeps the saved one and the elapsed time moves", async () => {
    const player = await mount({ durationSecs: 42 });
    player.fake.duration = NaN;
    await player.fire("loadedmetadata");
    player.fake.currentTime = 13.4;
    await player.fire("timeupdate");
    expect(player.time()).toBe("0:13 / 0:42");
  });

  test("scrubbing sets the playback position and the readout follows", async () => {
    const player = await mount({ durationSecs: 42 });
    player.fake.duration = 42;
    await player.fire("loadedmetadata");
    // react-dom here was loaded before the DOM existed, so it does not listen for input events; call its handler.
    const range = player.range();
    range.value = "30";
    const props = Object.entries(range).find(([key]) => key.startsWith("__reactProps$"))![1] as { onChange: (event: unknown) => void };
    await act(async () => props.onChange({ currentTarget: range }));
    expect(player.fake.currentTime).toBe(30);
    expect(player.time()).toBe("0:30 / 0:42");
  });

  test("play and pause drive the element and report to the caller", async () => {
    const seen: boolean[] = [];
    const player = await mount({ durationSecs: 42, onPlayingChange: (playing) => seen.push(playing) });
    player.fake.duration = 42;
    await player.fire("loadedmetadata");
    expect(player.toggle().getAttribute("aria-label")).toBe("Play");
    await act(async () => player.toggle().click());
    expect(player.fake.played).toBe(1);
    await player.fire("play");
    expect(player.toggle().getAttribute("aria-label")).toBe("Pause");
    await act(async () => player.toggle().click());
    expect(player.fake.paused_).toBe(1);
    await player.fire("pause");
    expect(seen).toEqual([true, false]);
  });

  test("an element error is reported, not swallowed", async () => {
    let errors = 0;
    const player = await mount({ durationSecs: 42, onError: () => { errors++; } });
    await player.fire("error");
    expect(errors).toBe(1);
  });

  test("a file that will not play ends in a calm Try again, not a stuck 0:00", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<MeetingAudioPlayer url="blob:note" durationSecs={42} />));
    await act(async () => (host.querySelector("[data-testid=note-audio-play]") as HTMLButtonElement).click());
    expect(host.querySelector("[data-testid=note-audio-time]")?.textContent).toBe("0:00 / 0:42");
    await act(async () => { host.querySelector("audio")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector("audio")).toBeNull();
    expect(host.textContent).toContain("Try again");
    expect(host.textContent).toContain("Couldn\u2019t load the audio just now.");
  });
});
