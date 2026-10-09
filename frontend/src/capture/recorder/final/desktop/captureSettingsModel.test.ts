import { describe, expect, test } from "bun:test";
import {
  downloadsReducer,
  formatModelSize,
  progressPercent,
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

  test("start, progress, done", () => {
    let state = downloadsReducer(empty, { type: "start", id: "QuantizedSmall" });
    expect(state.QuantizedSmall).toEqual({ status: "downloading", fraction: 0 });
    state = downloadsReducer(state, {
      type: "progress",
      id: "QuantizedSmall",
      fraction: 0.4,
    });
    expect(state.QuantizedSmall).toEqual({ status: "downloading", fraction: 0.4 });
    state = downloadsReducer(state, { type: "done", id: "QuantizedSmall" });
    expect(state).toEqual({});
  });

  test("progress for a download started elsewhere shows it", () => {
    const state = downloadsReducer(empty, {
      type: "progress",
      id: "QuantizedBase",
      fraction: 0.1,
    });
    expect(state.QuantizedBase).toEqual({ status: "downloading", fraction: 0.1 });
  });

  test("a failure stays on its row until Retry, and a late progress event does not hide it", () => {
    let state = downloadsReducer(empty, { type: "start", id: "QuantizedTiny" });
    state = downloadsReducer(state, {
      type: "fail",
      id: "QuantizedTiny",
      message: "Disk full",
    });
    expect(state.QuantizedTiny).toEqual({ status: "error", message: "Disk full" });
    expect(
      downloadsReducer(state, { type: "progress", id: "QuantizedTiny", fraction: 0.9 }),
    ).toBe(state);
    state = downloadsReducer(state, { type: "start", id: "QuantizedTiny" });
    expect(state.QuantizedTiny).toEqual({ status: "downloading", fraction: 0 });
  });

  test("one model's download leaves the others alone", () => {
    let state = downloadsReducer(empty, { type: "start", id: "QuantizedTiny" });
    state = downloadsReducer(state, { type: "start", id: "QuantizedBase" });
    state = downloadsReducer(state, { type: "done", id: "QuantizedTiny" });
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
