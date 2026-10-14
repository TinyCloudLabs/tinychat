import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NotePlaybackContext, type NotePlayback } from "@/lib/audio/notePlayback";
import { installDom } from "@/test/dom";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { hasSegmentTimes, sentenceTime, transcriptMarkdown, transcriptWithTimestamps } from "./transcriptSegments";

const sentences = [
  { index: 0, speaker_name: "Me", text: "Hello.", start_time: 0, end_time: 2 },
  { index: 1, speaker_name: "Them", text: "Let's begin.", start_time: 42, end_time: 45 },
];

test("timed copy and Markdown retain speaker, minute and hour clocks", () => {
  const long = [...sentences, { index: 2, speaker_name: "Me", text: "Done.", start_time: 3724, end_time: 3727 }];
  expect(transcriptWithTimestamps(long)).toBe("[00:00] Me: Hello.\n[00:42] Them: Let's begin.\n[1:02:04] Me: Done.");
  expect(transcriptMarkdown("Interview", null, long)).toContain("## Transcript\n\n[00:00] Me: Hello.");
});


test("PTX turns up to 60 seconds render, copy, follow, and seek as timed rows", async () => {
  const ptx = [
    { index: 0, speaker_name: "You", text: "First turn.", start_time: 0, end_time: 22.6 },
    { index: 1, speaker_name: "Them", text: "Second turn.", start_time: 22.6, end_time: 62 },
    { index: 2, speaker_name: "You", text: "Third turn.", start_time: 62, end_time: 121.9 },
    { index: 3, speaker_name: "Them", text: "Fourth turn.", start_time: 121.9, end_time: 181.9 },
  ];
  expect(ptx.map(sentenceTime)).toEqual([0, 22.6, 62, 121.9]);
  expect(hasSegmentTimes(ptx)).toBe(true);
  expect(transcriptWithTimestamps(ptx)).toContain("[01:02] You: Third turn.");
  const markup = renderToStaticMarkup(<TimestampedTranscript sentences={ptx} hasAudio />);
  expect(markup.match(/data-testid="transcript-segment"/g)).toHaveLength(4);
  expect(markup).toContain('aria-label="Play from 2:01"');

  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let playedFrom = -1;
  const render = (elapsed: number) => act(async () => root!.render(
    <NotePlaybackContext.Provider value={{ seek: null, elapsed, playing: true, playFrom: (seconds) => { playedFrom = seconds; }, onClock: () => {} }}>
      <TimestampedTranscript sentences={ptx} hasAudio />
    </NotePlaybackContext.Provider>,
  ));
  await render(70);
  expect(Array.from(host.querySelectorAll('[data-active="true"]'), (row) => row.textContent)).toEqual([expect.stringContaining("Third turn.")]);
  await act(async () => { (host.querySelector('[aria-label="Play from 1:02"]') as HTMLButtonElement).click(); });
  expect(playedFrom).toBe(62);
  await render(130);
  expect(Array.from(host.querySelectorAll('[data-active="true"]'), (row) => row.textContent)).toEqual([expect.stringContaining("Fourth turn.")]);
});

test("60-second boundary is inclusive, longer spans stay invalid, and majority still gates timing", () => {
  const atLimit = { index: 0, speaker_name: null, text: "At limit.", start_time: 0, end_time: 60 };
  const overLimit = { ...atLimit, end_time: 60.01 };
  expect(sentenceTime(atLimit)).toBe(0);
  expect(sentenceTime(overLimit)).toBeNull();

  const mostlyTimed = [atLimit, { ...atLimit, index: 1 }, { ...atLimit, index: 2 }, overLimit, { ...overLimit, index: 4 }];
  expect(hasSegmentTimes(mostlyTimed)).toBe(true);
  expect(hasSegmentTimes([atLimit, overLimit, { ...overLimit, index: 2 }])).toBe(false);

  const wholeNote = [{ ...atLimit, end_time: 639 }];
  expect(hasSegmentTimes(wholeNote)).toBe(false);
  expect(renderToStaticMarkup(<TimestampedTranscript sentences={wholeNote} hasAudio={false} />)).not.toContain("Play from");
  expect(transcriptWithTimestamps(wholeNote)).toBe("At limit.");
});
test("missing and coarse timings stay plain; no synthetic clock for a whole-note span", () => {
  const untimed = [{ index: 0, speaker_name: "You", text: "Old mono note.", start_time: 0, end_time: 0 }];
  expect(hasSegmentTimes(untimed)).toBe(false);
  expect(hasSegmentTimes([{ ...untimed[0], end_time: 3600 }])).toBe(false);
  expect(renderToStaticMarkup(<TimestampedTranscript sentences={untimed} hasAudio={false} />)).not.toContain("Play from");
  expect(transcriptWithTimestamps(untimed)).toBe("You: Old mono note.");
});

test("engine and valid legacy segments can seek, highlight, and copy timestamps; coarse and unknown timing cannot", async () => {
  const mixed = [
    { index: 0, speaker_name: "You", text: "Engine.", start_time: 0, end_time: 2, timing: "engine" },
    { index: 1, speaker_name: "You", text: "Coarse.", start_time: 0, end_time: 2, timing: "coarse" },
    { index: 2, speaker_name: "You", text: "Legacy.", start_time: 0, end_time: 2 },
    { index: 3, speaker_name: "You", text: "Unknown.", start_time: 0, end_time: 2, timing: "unknown" },
  ];
  expect(hasSegmentTimes(mixed.slice(0, 3))).toBe(true);
  expect(transcriptWithTimestamps(mixed)).toBe("[00:00] You: Engine.\nYou: Coarse.\n[00:00] You: Legacy.\nYou: Unknown.");

  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let playedFrom = -1;
  await act(async () => root!.render(
    <NotePlaybackContext.Provider value={{ seek: null, elapsed: 1, playing: true, playFrom: (seconds) => { playedFrom = seconds; }, onClock: () => {} }}>
      <TimestampedTranscript sentences={mixed} hasAudio />
    </NotePlaybackContext.Provider>,
  ));
  const rows = Array.from(host.querySelectorAll('[data-testid="transcript-segment"]'));
  expect(rows.map((row) => row.getAttribute("data-active"))).toEqual(["true", null, "true", null]);
  expect(rows.map((row) => row.querySelectorAll('button[aria-label^="Play from"]').length)).toEqual([1, 0, 1, 0]);
  await act(async () => { (rows[0]!.querySelector("button") as HTMLButtonElement).click(); });
  expect(playedFrom).toBe(0);
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

test("nested overlap highlights both speakers and follows the latest start through a seek", async () => {
  cleanup = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const overlapping = [
    { index: 0, speaker_name: "Me", text: "Long turn.", start_time: 0, end_time: 20 },
    { index: 1, speaker_name: "Them", text: "Short turn.", start_time: 5, end_time: 10 },
  ];
  const renders = new Map<number, number>();
  const onRowRender = (index: number) => renders.set(index, (renders.get(index) ?? 0) + 1);
  const scrolled: string[] = [];
  let playedFrom = -1;
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Element.prototype.getBoundingClientRect = () => ({ top: 700, bottom: 730 } as DOMRect);
  Element.prototype.scrollIntoView = function () { scrolled.push(this.textContent ?? ""); };
  const render = (elapsed: number) => act(async () => root!.render(
    <NotePlaybackContext.Provider value={{ seek: null, elapsed, playing: true, playFrom: (seconds) => { playedFrom = seconds; }, onClock: () => {} }}>
      <TimestampedTranscript sentences={overlapping} hasAudio onRowRender={onRowRender} />
    </NotePlaybackContext.Provider>,
  ));
  const activeText = () => Array.from(host.querySelectorAll('[data-active="true"]'), (row) => row.textContent);

  await render(0);
  expect(activeText()).toEqual([expect.stringContaining("Long turn.")]);
  const meRenders = renders.get(0);
  await render(5);
  expect(activeText()).toEqual([expect.stringContaining("Long turn."), expect.stringContaining("Short turn.")]);
  expect(renders.get(0)).toBe(meRenders);
  expect(scrolled.at(-1)).toContain("Short turn.");
  const overlapRenders = new Map(renders);
  await render(7);
  expect(activeText()).toHaveLength(2);
  expect(renders).toEqual(overlapRenders);
  expect(scrolled).toHaveLength(2);
  await render(10);
  expect(activeText()).toEqual([expect.stringContaining("Long turn.")]);
  await act(async () => { (host.querySelector('[aria-label="Play from 0:05"]') as HTMLButtonElement).click(); });
  expect(playedFrom).toBe(5);
  await render(5);
  expect(activeText()).toEqual([expect.stringContaining("Long turn."), expect.stringContaining("Short turn.")]);
  expect(scrolled.at(-1)).toContain("Short turn.");
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
