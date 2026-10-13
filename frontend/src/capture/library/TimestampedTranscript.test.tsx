import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NotePlaybackContext, type NotePlayback } from "@/lib/audio/notePlayback";
import { installDom } from "@/test/dom";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { hasSegmentTimes, transcriptMarkdown, transcriptWithTimestamps } from "./transcriptSegments";

const sentences = [
  { index: 0, speaker_name: "Me", text: "Hello.", start_time: 0, end_time: 2 },
  { index: 1, speaker_name: "Them", text: "Let's begin.", start_time: 42, end_time: 45 },
];

test("timed copy and Markdown retain speaker, minute and hour clocks", () => {
  const long = [...sentences, { index: 2, speaker_name: "Me", text: "Done.", start_time: 3724, end_time: 3727 }];
  expect(transcriptWithTimestamps(long)).toBe("[00:00] Me: Hello.\n[00:42] Them: Let's begin.\n[1:02:04] Me: Done.");
  expect(transcriptMarkdown("Interview", null, long)).toContain("## Transcript\n\n[00:00] Me: Hello.");
});

test("missing and coarse timings stay plain; no synthetic clock for a whole-note span", () => {
  const untimed = [{ index: 0, speaker_name: "You", text: "Old mono note.", start_time: 0, end_time: 0 }];
  expect(hasSegmentTimes(untimed)).toBe(false);
  expect(hasSegmentTimes([{ ...untimed[0], end_time: 3600 }])).toBe(false);
  expect(renderToStaticMarkup(<TimestampedTranscript sentences={untimed} hasAudio={false} />)).not.toContain("Play from");
  expect(transcriptWithTimestamps(untimed)).toBe("You: Old mono note.");
});

test("no local audio leaves timestamps readable with a seek reason", () => {
  const html = renderToStaticMarkup(<TimestampedTranscript sentences={sentences} hasAudio={false} />);
  expect(html).toContain("0:42");
  expect(html).toContain("seeking is unavailable");
  expect(html).not.toContain('aria-label="Play from');
});

test("timestamp controls keep a 44 px coarse-pointer target", () => {
  const html = renderToStaticMarkup(<TimestampedTranscript sentences={sentences} hasAudio />);
  expect(html).toContain("min-h-11");
  expect(html).toContain("[@media(pointer:fine)]:min-h-0");
});

test("a single speaker has no repeated label; an hour of segments keeps its final timestamp", () => {
  const hour = Array.from({ length: 121 }, (_, index) => ({
    index, speaker_name: "You", text: `Sentence ${index}.`, start_time: index * 30, end_time: index * 30 + 2,
  }));
  const html = renderToStaticMarkup(<TimestampedTranscript sentences={hour} hasAudio />);
  expect(html).toContain('aria-label="Play from 1:00:00"');
  expect(html).not.toContain('>You</p>');
  expect((html.match(/data-testid="transcript-segment"/g) ?? [])).toHaveLength(121);
});

let cleanup: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  cleanup?.();
  cleanup = undefined;
});

test("timestamp seeks, playback highlights, manual scroll suspends follow, and the pill restores it", async () => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let playedFrom = -1;
  let scrolls = 0;
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Element.prototype.scrollIntoView = () => { scrolls++; };
  Element.prototype.getBoundingClientRect = () => ({ top: 700, bottom: 730 } as DOMRect);
  const render = async (elapsed: number, playing = true) => act(async () => root!.render(
    <NotePlaybackContext.Provider value={{ seek: null, elapsed, playing, playFrom: (seconds) => { playedFrom = seconds; }, onClock: () => {} } satisfies NotePlayback}>
      <TimestampedTranscript sentences={sentences} hasAudio />
    </NotePlaybackContext.Provider>,
  ));
  await render(1);
  expect(host.querySelectorAll('[data-active="true"]')).toHaveLength(1);
  expect(scrolls).toBe(1);
  await act(async () => { (host.querySelector('[aria-label="Play from 0:42"]') as HTMLButtonElement).click(); });
  expect(playedFrom).toBe(42);
  await act(async () => { host.querySelector("[data-testid=timed-transcript]")!.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true })); });
  await render(43);
  expect(host.querySelectorAll('[data-active="true"]')).toHaveLength(1);
  expect(scrolls).toBe(1);
  expect(host.textContent).toContain("Follow playback");
  await act(async () => { (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Follow playback")!).click(); });
  expect(scrolls).toBe(2);
});

test("repeated clock ticks render no unchanged rows in a 2,000-segment note", async () => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Element.prototype.getBoundingClientRect = () => ({ top: 400, bottom: 430 } as DOMRect);
  const long = Array.from({ length: 2000 }, (_, index) => ({
    index, speaker_name: null, text: `Sentence ${index}.`, start_time: index * 2, end_time: index * 2 + 2,
  }));
  const renders = new Map<number, number>();
  const onRowRender = (index: number) => renders.set(index, (renders.get(index) ?? 0) + 1);
  const render = (elapsed: number) => act(async () => root!.render(
    <NotePlaybackContext.Provider value={{ seek: null, elapsed, playing: true, playFrom: () => {}, onClock: () => {} }}>
      <TimestampedTranscript sentences={long} hasAudio onRowRender={onRowRender} />
    </NotePlaybackContext.Provider>,
  ));
  await render(0.25);
  const initial = [...renders.values()].reduce((sum, count) => sum + count, 0);
  for (const elapsed of [0.5, 0.75, 1, 1.5]) await render(elapsed);
  expect([...renders.values()].reduce((sum, count) => sum + count, 0)).toBe(initial);
  await render(2.25);
  expect([...renders.values()].reduce((sum, count) => sum + count, 0)).toBe(initial + 2);
  expect(host.querySelectorAll('[data-active="true"]')).toHaveLength(1);
});
