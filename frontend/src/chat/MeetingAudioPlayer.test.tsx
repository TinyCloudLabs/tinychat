// A note's audio player (TC-761; moved from the Voice notes card's tests):
// Play audio, then how much of a long file has loaded, then the player.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { installDom } from "@/test/dom";
import { setCapturePlaybackBlocked, stopAllPlayback } from "@/lib/audio/playback";
import { PHONE_AUDIO_UNAVAILABLE, playbackDuration, scrubTarget } from "./audioPlayback";
import { MeetingAudioPlayer, MeetingAudioPlayerView, stateForResolvedUrl, type PlayerState } from "./MeetingAudioPlayer";

const render = (state: PlayerState, durationSecs?: number | null) => renderToStaticMarkup(<MeetingAudioPlayerView state={state} onPlay={() => {}} durationSecs={durationSecs} />);

describe("MeetingAudioPlayerView", () => {
  test("Play audio first; the file is read only when asked", () => {
    const html = render({ phase: "idle" });
    expect(html).toContain("Play audio");
    expect(html).not.toContain("<audio");
    const player = renderToStaticMarkup(<MeetingAudioPlayer resolveUrl={async () => "x"} />);
    expect(player).toContain('<audio preload="none" class="sr-only" data-testid="note-audio-player"');
    expect(player).not.toContain("src=");
  });

  test("a note on this phone has its source set from the start, so the first tap can play it", () => {
    const player = renderToStaticMarkup(<MeetingAudioPlayer url="capacitor://localhost/_capacitor_file_/a.m4a" durationSecs={42} />);
    expect(player).toContain('src="capacitor://localhost/_capacitor_file_/a.m4a"');
    expect(player).toContain("Play audio");
  });

  test("a long note shows how much of its audio has loaded", () => {
    const html = render({ phase: "loading", percent: 41 });
    expect(html).toContain("Loading audio… 41%");
    expect(html).toContain('role="status"');
    // The spinner holds still with reduced motion.
    expect(html).toContain("motion-safe:animate-spin");
  });

  test("loaded: the controls, with the audio element left to the player", () => {
    const html = render({ phase: "ready", url: "blob:capacitor://localhost/0f1e" });
    expect(html).toContain('data-testid="note-audio-controls"');
    expect(html).not.toContain("<audio");
  });

  test("a read that failed offers Try again; audio no longer stored says so", () => {
    expect(render({ phase: "failed" })).toContain("Try again");
    expect(render({ phase: "missing" })).toContain("The audio is no longer stored.");
  });

  test("a local URL that could not be resolved shows calm copy, with Try again, and no internal text", () => {
    const html = render({ phase: "failed", reason: PHONE_AUDIO_UNAVAILABLE });
    expect(html).toContain("Couldn\u2019t open this note\u2019s audio on this phone.");
    expect(html).toContain("Try again");
  });

  test("a local URL is resolved into the player as it is, and a rejection becomes its reason", async () => {
    expect(await stateForResolvedUrl(async () => "capacitor://localhost/_capacitor_file_/a.m4a")).toEqual({
      phase: "ready",
      url: "capacitor://localhost/_capacitor_file_/a.m4a",
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cause = new Error("Could not open this phone's audio: loadVoiceNoteAudio: Key not found: xyz/abc");
      expect(await stateForResolvedUrl(async () => { throw cause; })).toEqual({ phase: "failed", reason: PHONE_AUDIO_UNAVAILABLE });
      expect(logged).toHaveBeenCalledWith("[Audio] Could not resolve this phone's audio", cause);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the ready player's length", () => {
  test("shows the saved length before anything has loaded, with a scrubber that already spans it", () => {
    const html = render({ phase: "ready", url: "capacitor://localhost/_capacitor_file_/a.m4a" }, 42);
    expect(html).toContain("0:00 / 0:42");
    expect(html).not.toContain("00:00");
    expect(html).toContain("Loading audio…");
    expect(html).toMatch(/<input[^>]*type="range"[^>]*max="42"/);
    expect(html).not.toMatch(/<input[^>]*type="range"[^>]*disabled=""/);
    expect(html).toContain('aria-valuetext="0:00 of 0:42"');
    expect(html).not.toMatch(/<audio[^>]*controls/);
  });

  test("with no saved length it says Loading… rather than 0:00 / 0:00", () => {
    const html = render({ phase: "ready", url: "blob:x" }, null);
    expect(html).toContain("Loading…");
    expect(html).toMatch(/<input[^>]*type="range"[^>]*disabled=""/);
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

describe("the player in a DOM", () => {
  let cleanupDom: (() => void) | undefined;
  let root: Root | null = null;
  let logged: ReturnType<typeof spyOn> | null = null;
  afterEach(async () => {
    setCapturePlaybackBlocked(false);
    if (root) await act(async () => root!.unmount());
    root = null;
    logged?.mockRestore();
    logged = null;
    cleanupDom?.();
    cleanupDom = undefined;
  });

  interface FakeMedia {
    duration: number;
    currentTime: number;
    paused: boolean;
    readyState: number;
    error: unknown;
    seekable: [number, number][];
    plays: { src: string | null }[];
    pauses: number;
    loads: number;
    setTimes: number[];
    playResult: () => Promise<void>;
  }

  const mount = async (props: Partial<React.ComponentProps<typeof MeetingAudioPlayer>>) => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (next: typeof props) => act(async () => root!.render(<MeetingAudioPlayer {...next} />));
    await render(props);
    const audio = host.querySelector("audio") as HTMLAudioElement;
    const fake: FakeMedia = { duration: NaN, currentTime: 0, paused: true, readyState: 0, error: null, seekable: [], plays: [], pauses: 0, loads: 0, setTimes: [], playResult: () => Promise.resolve() };
    Object.defineProperty(audio, "duration", { get: () => fake.duration });
    Object.defineProperty(audio, "readyState", { get: () => fake.readyState });
    Object.defineProperty(audio, "error", { get: () => fake.error });
    Object.defineProperty(audio, "seekable", { get: () => ({ length: fake.seekable.length, start: (i: number) => fake.seekable[i][0], end: (i: number) => fake.seekable[i][1] }) });
    Object.defineProperty(audio, "currentTime", { get: () => fake.currentTime, set: (value: number) => { fake.setTimes.push(value); fake.currentTime = value; } });
    Object.defineProperty(audio, "paused", { get: () => fake.paused });
    audio.play = () => { fake.plays.push({ src: audio.getAttribute("src") }); fake.paused = false; return fake.playResult(); };
    audio.pause = () => { fake.pauses++; fake.paused = true; };
    audio.load = () => { fake.loads++; fake.error = null; };
    const fire = (type: string) => act(async () => { audio.dispatchEvent(new Event(type)); });
    const metadata = async (duration: number, seekable: [number, number][] = [[0, duration]]) => {
      fake.duration = duration;
      fake.readyState = 1;
      fake.seekable = seekable;
      await fire("loadedmetadata");
    };
    const q = (selector: string) => host.querySelector(selector) as HTMLElement;
    const time = () => q("[data-testid=note-audio-time]")?.textContent;
    const range = () => q("input[type=range]") as HTMLInputElement;
    const scrub = async (value: number) => {
      // react-dom here was loaded before the DOM existed, so it does not listen for input events; call its handler.
      const input = range();
      input.value = String(value);
      const handlers = Object.entries(input).find(([key]) => key.startsWith("__reactProps$"))![1] as { onChange: (event: unknown) => void };
      await act(async () => handlers.onChange({ currentTarget: input }));
    };
    return { host, audio, fake, fire, metadata, q, time, range, scrub, render };
  };

  test("the first tap calls play() inside the click, before the source has been resolved", async () => {
    let resolve!: (url: string) => void;
    const player = await mount({ durationSecs: 42, resolveUrl: () => new Promise<string>((done) => { resolve = done; }) });
    const button = player.q("[data-testid=note-audio-play]");
    // Read inside the click's own turn: the call happened in the click handler itself.
    let playsInClick: FakeMedia["plays"] = [];
    act(() => {
      button.click();
      playsInClick = [...player.fake.plays];
    });
    expect(playsInClick).toEqual([{ src: null }]);
    await act(async () => {});
    expect(player.host.textContent).toContain("Loading audio…");

    await act(async () => resolve("capacitor://localhost/_capacitor_file_/a.m4a"));
    expect(player.audio.getAttribute("src")).toBe("capacitor://localhost/_capacitor_file_/a.m4a");
    expect(player.fake.plays).toEqual([{ src: null }, { src: "capacitor://localhost/_capacitor_file_/a.m4a" }]);
    expect(player.time()).toBe("0:00 / 0:42");
  });

  test("the same holds for a blob read", async () => {
    let resolve!: (blob: Blob) => void;
    const created = spyOn(URL, "createObjectURL").mockReturnValue("blob:note");
    try {
      const player = await mount({ durationSecs: 42, load: () => new Promise<Blob | null>((done) => { resolve = done; }) });
      let playsInClick: FakeMedia["plays"] = [];
      act(() => {
        player.q("[data-testid=note-audio-play]").click();
        playsInClick = [...player.fake.plays];
      });
      expect(playsInClick).toEqual([{ src: null }]);
      await act(async () => resolve(new Blob(["x"])));
      expect(player.fake.plays).toEqual([{ src: null }, { src: "blob:note" }]);
    } finally {
      created.mockRestore();
    }
  });

  test("a note on this phone plays on the first tap with its source already set", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    expect(player.audio.getAttribute("src")).toBe("blob:note");
    let playsInClick: FakeMedia["plays"] = [];
    act(() => {
      player.q("[data-testid=note-audio-play]").click();
      playsInClick = [...player.fake.plays];
    });
    expect(playsInClick).toEqual([{ src: "blob:note" }]);
    expect(player.q("[data-testid=note-audio-toggle]")).not.toBeNull();
  });

  test("a play the browser refuses ends in Try again, with the cause in the console", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    const refused = new DOMException("The request is not allowed by the user agent", "NotAllowedError");
    player.fake.playResult = () => Promise.reject(refused);
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.host.textContent).toContain("Try again");
    expect(player.host.textContent).toContain("Couldn\u2019t load the audio just now.");
    expect(logged).toHaveBeenCalledWith("[Audio] Could not play", refused);
  });

  test("an outdated offline copy tells the listener to reconnect", async () => {
    const message = "This audio changed; reconnect to play the latest version";
    const player = await mount({ load: async () => { throw new Error(message); } });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.host.textContent).toContain(message);
  });

  test("a play that a pause or a new source supersedes is not an error", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    player.fake.playResult = () => Promise.reject(new DOMException("interrupted", "AbortError"));
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.host.textContent).not.toContain("Try again");
    expect(logged).not.toHaveBeenCalled();
  });

  test("loading, then ready: the saved length shows throughout", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.time()).toBe("0:00 / 0:42");
    expect(player.range().disabled).toBe(false);
    expect(player.host.querySelector("[role=status]")?.textContent).toBe("Loading audio…");

    await player.metadata(Infinity);
    expect(player.time()).toBe("0:00 / 0:42");
    expect(player.range().max).toBe("42");
    expect(player.host.querySelector("[role=status]")).toBeNull();

    player.fake.duration = 41.6;
    await player.fire("durationchange");
    expect(player.time()).toBe("0:00 / 0:42");
    expect(player.range().max).toBe("41.6");
  });

  test("a stream that never reports a length keeps the saved one and the elapsed time moves", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await player.metadata(NaN);
    player.fake.currentTime = 13.4;
    await player.fire("timeupdate");
    expect(player.time()).toBe("0:13 / 0:42");
  });

  test("scrubbing before the media answers waits for it, and the thumb holds where the user put it", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await player.scrub(30);
    expect(player.fake.setTimes).toEqual([]);
    expect(player.time()).toBe("0:30 / 0:42");

    await player.metadata(42);
    expect(player.fake.setTimes).toEqual([30]);
    await player.fire("seeked");
    expect(player.time()).toBe("0:30 / 0:42");
  });

  test("scrubbing on a loaded media sets the position, and the readout then follows the media", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await player.metadata(42);
    await player.scrub(30);
    expect(player.fake.setTimes).toEqual([30]);
    player.fake.currentTime = 29.9;
    await player.fire("seeked");
    expect(player.time()).toBe("0:29 / 0:42");
  });

  test("a seek the media cannot take is not shown as if it had happened", async () => {
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const player = await mount({ url: "blob:note", durationSecs: 42 });
      await act(async () => player.q("[data-testid=note-audio-play]").click());
      await player.metadata(Infinity, [[0, 10]]);
      await player.scrub(30);
      expect(player.fake.setTimes).toEqual([]);
      expect(player.time()).toBe("0:00 / 0:42");
      expect(warned).toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  test("a seek queued to the saved end lands on the media's end when the file is shorter", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await player.scrub(42);
    expect(player.time()).toBe("0:42 / 0:42");
    await player.metadata(20);
    expect(player.fake.setTimes).toEqual([20]);
    expect(player.time()).toBe("0:20 / 0:20");
    player.fake.currentTime = 20;
    await player.fire("seeked");
    expect(player.time()).toBe("0:20 / 0:20");
  });

  test("a queued seek the media cannot take once it answers is dropped", async () => {
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const player = await mount({ url: "blob:note", durationSecs: 42 });
      await act(async () => player.q("[data-testid=note-audio-play]").click());
      await player.scrub(30);
      await player.metadata(NaN, []);
      expect(player.fake.setTimes).toEqual([]);
      expect(player.time()).toBe("0:00 / 0:42");
    } finally {
      warned.mockRestore();
    }
  });

  test("the scrubber announces clock time to assistive technology", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await player.metadata(42);
    player.fake.currentTime = 13.4;
    await player.fire("timeupdate");
    expect(player.range().getAttribute("aria-valuetext")).toBe("0:13 of 0:42");
  });

  test("play and pause drive the element and report to the caller; a finished clip plays again", async () => {
    const seen: boolean[] = [];
    const player = await mount({ url: "blob:note", durationSecs: 42, onPlayingChange: (playing) => seen.push(playing) });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await player.metadata(42);
    await player.fire("play");
    expect(player.q("[data-testid=note-audio-toggle]").getAttribute("aria-label")).toBe("Pause");
    await act(async () => player.q("[data-testid=note-audio-toggle]").click());
    expect(player.fake.pauses).toBe(1);
    await player.fire("pause");
    expect(player.q("[data-testid=note-audio-toggle]").getAttribute("aria-label")).toBe("Play");

    await act(async () => player.q("[data-testid=note-audio-toggle]").click());
    await player.fire("play");
    player.fake.paused = true;
    await player.fire("ended");
    expect(player.q("[data-testid=note-audio-toggle]").getAttribute("aria-label")).toBe("Play");
    const playsBefore = player.fake.plays.length;
    await act(async () => player.q("[data-testid=note-audio-toggle]").click());
    expect(player.fake.plays.length).toBe(playsBefore + 1);
    await player.fire("play");
    expect(seen.at(-1)).toBe(true);
  });

  test("a moment plays from its second, once the audio is there", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await player.render({ url: "blob:note", durationSecs: 42, seek: { seconds: 20, nonce: 1 } });
    expect(player.fake.plays).toEqual([{ src: "blob:note" }]);
    await player.metadata(42);
    expect(player.fake.setTimes).toEqual([20]);
    await player.render({ url: "blob:note", durationSecs: 42, seek: { seconds: 5, nonce: 2 } });
    expect(player.fake.setTimes).toEqual([20, 5]);
    expect(player.fake.plays.length).toBe(2);
  });

  test("a playing note pauses when its kept pane is hidden or its view closes", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.fake.paused).toBe(false);
    player.host.classList.add("hidden");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(player.fake.paused).toBe(true);
    player.host.classList.remove("hidden");
    await act(async () => player.q("[data-testid=note-audio-toggle]").click());
    expect(player.fake.paused).toBe(false);
    await act(async () => root!.unmount());
    root = null;
    expect(player.fake.paused).toBe(true);
  });

  test("Play cannot start while capture is active", async () => {
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    setCapturePlaybackBlocked(true);
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.fake.plays).toHaveLength(0);
    setCapturePlaybackBlocked(false);
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.fake.plays).toHaveLength(1);
  });

  test("stopping a pending file load prevents it from playing after capture begins", async () => {
    let resolve!: (url: string) => void;
    const player = await mount({ resolveUrl: () => new Promise<string>((done) => { resolve = done; }) });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    await act(async () => stopAllPlayback());
    expect(player.fake.paused).toBe(true);
    await act(async () => resolve("blob:late-note"));
    expect(player.fake.plays).toHaveLength(1);
    expect(player.host.textContent).toContain("Play audio");
  });

  test("an element error ends in a calm Try again, not a stuck 0:00, and Try again reloads the file", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});
    const player = await mount({ url: "blob:note", durationSecs: 42 });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.time()).toBe("0:00 / 0:42");
    player.fake.error = { code: 4 };
    await player.fire("error");
    expect(player.q("[data-testid=note-audio-controls]")).toBeNull();
    expect(player.host.textContent).toContain("Try again");
    expect(player.host.textContent).toContain("Couldn\u2019t load the audio just now.");

    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.fake.loads).toBe(1);
    expect(player.fake.plays.length).toBe(2);
  });

  test("a phone file that cannot be resolved shows calm copy and the audio element stays mounted", async () => {
    logged = spyOn(console, "error").mockImplementation(() => {});
    const player = await mount({ durationSecs: 42, resolveUrl: async () => { throw new Error("Key not found: xyz/abc"); } });
    await act(async () => player.q("[data-testid=note-audio-play]").click());
    expect(player.host.textContent).toContain(PHONE_AUDIO_UNAVAILABLE);
    expect(player.host.textContent).not.toContain("Key not found");
    expect(player.host.querySelector("audio")).toBe(player.audio);
  });
});
