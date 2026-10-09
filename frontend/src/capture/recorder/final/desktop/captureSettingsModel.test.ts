import { describe, expect, test } from "bun:test";
import type { WhisperModelInfo } from "@/lib/voiceNotes/desktopCaptureExtras";
import {
  adjacentRadio,
  downloadedAnnouncement,
  downloadsReducer,
  focusAfterFail,
  focusAfterGet,
  focusAfterSync,
  formatModelSize,
  newlyDownloaded,
  partitionModels,
  progressPercent,
  progressText,
  type Downloads,
} from "./captureSettingsModel";

describe("formatModelSize", () => {
  test("quotes decimal megabytes, as the design does", () => {
    expect(formatModelSize(44_000_000)).toBe("44 MB");
    expect(formatModelSize(874_000_000)).toBe("874 MB");
    expect(formatModelSize(81_600_000)).toBe("82 MB");
  });
  test("switches to gigabytes at 1000 MB", () => {
    expect(formatModelSize(999_400_000)).toBe("999 MB");
    expect(formatModelSize(1_550_000_000)).toBe("1.6 GB");
  });
  test("rejects a size that is not a size", () => {
    expect(() => formatModelSize(-1)).toThrow(RangeError);
    expect(() => formatModelSize(Number.NaN)).toThrow(RangeError);
  });
});

describe("downloadsReducer", () => {
  const empty: Downloads = {};

  const info = (
    id: WhisperModelInfo["id"],
    over: Partial<WhisperModelInfo> = {},
  ): WhisperModelInfo => ({
    id,
    label: id,
    sizeBytes: 1,
    downloaded: false,
    selected: false,
    downloading: false,
    progress: null,
    ...over,
  });

  test("start, progress, then sync clears it once the model is on disk", () => {
    let state = downloadsReducer(empty, { type: "start", id: "QuantizedSmall" });
    expect(state.QuantizedSmall).toEqual({ status: "downloading", fraction: 0 });
    state = downloadsReducer(state, {
      type: "progress",
      id: "QuantizedSmall",
      fraction: 0.4,
    });
    expect(state.QuantizedSmall).toEqual({ status: "downloading", fraction: 0.4 });
    state = downloadsReducer(state, {
      type: "sync",
      models: [info("QuantizedSmall", { downloaded: true })],
    });
    expect(state).toEqual({});
  });

  test("sync shows a download already under way, with its progress, or keeps what was shown when there is none yet", () => {
    let state = downloadsReducer(empty, {
      type: "sync",
      models: [
        info("QuantizedBase", { downloading: true, progress: 0.3 }),
        info("QuantizedSmall", { downloading: true, progress: null }),
        info("QuantizedTiny"),
      ],
    });
    expect(state).toEqual({
      QuantizedBase: { status: "downloading", fraction: 0.3 },
      QuantizedSmall: { status: "downloading", fraction: 0 },
    });
    state = downloadsReducer(state, {
      type: "progress",
      id: "QuantizedSmall",
      fraction: 0.5,
    });
    state = downloadsReducer(state, {
      type: "sync",
      models: [info("QuantizedSmall", { downloading: true, progress: null })],
    });
    expect(state.QuantizedSmall).toEqual({ status: "downloading", fraction: 0.5 });
  });

  test("sync leaves a failed row and a model that is neither on disk nor downloading alone", () => {
    const failed = downloadsReducer(empty, {
      type: "fail",
      id: "QuantizedTiny",
      message: "Disk full",
    });
    expect(
      downloadsReducer(failed, { type: "sync", models: [info("QuantizedTiny")] }),
    ).toEqual(failed);
  });

  test("sync of a model on disk drops a failed row too", () => {
    const failed = downloadsReducer(empty, {
      type: "fail",
      id: "QuantizedTiny",
      message: "Disk full",
    });
    expect(
      downloadsReducer(failed, {
        type: "sync",
        models: [info("QuantizedTiny", { downloaded: true })],
      }),
    ).toEqual({});
  });

  test("progress for a download started elsewhere shows it", () => {
    const state = downloadsReducer(empty, {
      type: "progress",
      id: "QuantizedBase",
      fraction: 0.1,
    });
    expect(state.QuantizedBase).toEqual({ status: "downloading", fraction: 0.1 });
  });

  test("a failure stays on its row until a new attempt shows progress", () => {
    let state = downloadsReducer(empty, { type: "start", id: "QuantizedTiny" });
    state = downloadsReducer(state, {
      type: "fail",
      id: "QuantizedTiny",
      message: "Disk full",
    });
    expect(state.QuantizedTiny).toEqual({ status: "error", message: "Disk full" });
    expect(
      downloadsReducer(state, { type: "progress", id: "QuantizedTiny", fraction: 0.9 })
        .QuantizedTiny,
    ).toEqual({ status: "downloading", fraction: 0.9 });
    state = downloadsReducer(state, { type: "start", id: "QuantizedTiny" });
    expect(state.QuantizedTiny).toEqual({ status: "downloading", fraction: 0 });
  });

  test("one model's download leaves the others alone", () => {
    let state = downloadsReducer(empty, { type: "start", id: "QuantizedTiny" });
    state = downloadsReducer(state, { type: "start", id: "QuantizedBase" });
    state = downloadsReducer(state, {
      type: "sync",
      models: [info("QuantizedTiny", { downloaded: true })],
    });
    expect(Object.keys(state)).toEqual(["QuantizedBase"]);
  });

  test("progress is clamped to 0..1", () => {
    const high = downloadsReducer(empty, { type: "progress", id: "QuantizedTiny", fraction: 7 });
    const nan = downloadsReducer(empty, { type: "progress", id: "QuantizedTiny", fraction: Number.NaN });
    expect(high.QuantizedTiny).toEqual({ status: "downloading", fraction: 1 });
    expect(nan.QuantizedTiny).toEqual({ status: "downloading", fraction: 0 });
  });
});

test("progressPercent rounds to a whole percent", () => {
  expect(progressPercent(0.404)).toBe(40);
  expect(progressPercent(0.996)).toBe(100);
  expect(progressPercent(-1)).toBe(0);
});

describe("the model picker's keyboard model", () => {
  const info = (
    id: WhisperModelInfo["id"],
    downloaded = false,
  ): WhisperModelInfo => ({
    id,
    label: `Whisper ${id}`,
    sizeBytes: 1,
    downloaded,
    selected: false,
    downloading: false,
    progress: null,
  });
  const models = [
    info("QuantizedTinyEn", true),
    info("QuantizedTiny"),
    info("QuantizedBaseEn", true),
    info("QuantizedBase"),
    info("QuantizedSmallEn", true),
  ];

  test("partitionModels: radios are the downloaded models in order, the rest are available", () => {
    const { radios, available } = partitionModels(models, null);
    expect(radios.map((m) => m.id)).toEqual([
      "QuantizedTinyEn",
      "QuantizedBaseEn",
      "QuantizedSmallEn",
    ]);
    expect(available.map((m) => m.id)).toEqual(["QuantizedTiny", "QuantizedBase"]);
  });

  test("the tab stop is the checked radio, else the first radio, else nothing", () => {
    expect(partitionModels(models, "QuantizedBaseEn").tabStop).toBe("QuantizedBaseEn");
    expect(partitionModels(models, null).tabStop).toBe("QuantizedTinyEn");
    // A selection that is not on disk checks nothing, so the first radio holds the tab stop.
    expect(partitionModels(models, "QuantizedBase").tabStop).toBe("QuantizedTinyEn");
    expect(partitionModels(models.map((m) => ({ ...m, downloaded: false })), null).tabStop).toBeNull();
  });

  test("adjacentRadio moves among radios only and wraps both ways", () => {
    const { radios } = partitionModels(models, null);
    expect(adjacentRadio(radios, "QuantizedTinyEn", 1)?.id).toBe("QuantizedBaseEn");
    expect(adjacentRadio(radios, "QuantizedSmallEn", 1)?.id).toBe("QuantizedTinyEn");
    expect(adjacentRadio(radios, "QuantizedTinyEn", -1)?.id).toBe("QuantizedSmallEn");
    expect(adjacentRadio(radios, "QuantizedTiny", 1)).toBeNull();
    expect(adjacentRadio(radios, null, 1)).toBeNull();
    expect(adjacentRadio([], "QuantizedTinyEn", 1)).toBeNull();
  });

  test("Get puts focus on the row's progress element", () => {
    expect(focusAfterGet("QuantizedBase")).toEqual({ id: "QuantizedBase", to: "progress" });
  });

  test("a finished download moves focus to its radio only if focus was on its progress element", () => {
    expect(focusAfterSync("QuantizedSmallEn", models)).toEqual({ id: "QuantizedSmallEn", to: "radio" });
    expect(focusAfterSync(null, models)).toBeNull();
    // Still not on disk (a sync during the download): focus stays where it is.
    expect(focusAfterSync("QuantizedBase", models)).toBeNull();
  });

  test("a failed download moves focus to Retry only if focus was on that row's progress element", () => {
    expect(focusAfterFail("QuantizedBase", "QuantizedBase")).toEqual({ id: "QuantizedBase", to: "retry" });
    expect(focusAfterFail("QuantizedTiny", "QuantizedBase")).toBeNull();
    expect(focusAfterFail(null, "QuantizedBase")).toBeNull();
  });

  test("newlyDownloaded names models that came onto disk since the last list, and nothing on the first", () => {
    const before = models;
    const after = models.map((m) => (m.id === "QuantizedBase" ? { ...m, downloaded: true } : m));
    expect(newlyDownloaded(before, after).map((m) => m.id)).toEqual(["QuantizedBase"]);
    expect(newlyDownloaded(null, after)).toEqual([]);
    expect(newlyDownloaded(after, after)).toEqual([]);
  });

  test("the announcement and the progress text", () => {
    expect(downloadedAnnouncement(["Whisper Base (English)"])).toBe("Whisper Base (English) downloaded");
    expect(downloadedAnnouncement(["A", "B"])).toBe("A and B downloaded");
    expect(progressText(0.4)).toBe("Downloading, 40%");
  });
});
