import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MODE_STOPS } from "./transcriptionModes";
import { PrivacyScale, nearestStop, stopFraction } from "./PrivacyScale";

describe("privacy scale geometry", () => {
  test("stops are spread evenly from 0 to 1", () => {
    expect([0, 1, 2].map((i) => stopFraction(i, 3))).toEqual([0, 0.5, 1]);
    expect(stopFraction(0, 1)).toBe(0);
  });
  test("a drag lands on the nearest stop and stays on the rail", () => {
    expect(nearestStop(0.2, 3)).toBe(0);
    expect(nearestStop(0.3, 3)).toBe(1);
    expect(nearestStop(0.8, 3)).toBe(2);
    expect(nearestStop(-0.5, 3)).toBe(0);
    expect(nearestStop(4, 3)).toBe(2);
    expect(nearestStop(0.9, 1)).toBe(0);
  });
});

test("the slider is named for the transcription mode it selects", () => {
  const html = renderToStaticMarkup(createElement(PrivacyScale, {
    stops: MODE_STOPS.map((stop) => ({ stop, available: true })),
    mode: "skip",
    onChoose: () => null,
    step: () => "local",
    onUnavailable: () => {},
  }));
  expect(html).toContain('role="slider" tabindex="0" aria-label="Transcription mode"');
});
