import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let finalEnabled = false;
mock.module("./final/recorderFinalFlag", () => ({
  recorderFinalEnabled: () => finalEnabled,
}));
mock.module("./liveCapture", () => ({
  edgeLevel: (sample: number) => sample,
  liveCapture: { subscribeLevel: () => () => {} },
  useLiveCapture: () => ({
    source: "voice-note",
    warning: false,
    startedAt: 1,
  }),
}));

const { LiveEdge } = await import("./LiveEdge");

describe("LiveEdge", () => {
  test("renders nothing when the final recorder is enabled", () => {
    finalEnabled = true;
    expect(renderToStaticMarkup(<LiveEdge />)).toBe("");
  });

  test("keeps the existing markup when the final recorder is disabled", () => {
    finalEnabled = false;
    expect(renderToStaticMarkup(<LiveEdge />)).toBe(
      '<div aria-hidden="true" class="live-edge" data-source="voice-note" data-tone="live"></div>',
    );
  });
});
