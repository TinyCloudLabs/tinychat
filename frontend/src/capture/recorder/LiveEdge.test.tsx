import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { liveCapture } from "./liveCapture";
import { LiveEdge } from "./LiveEdge";

afterEach(() => liveCapture.set(null));

function render(finalEnabled: boolean): string {
  liveCapture.set({ source: "voice-note", warning: false, startedAt: 1 });
  return renderToStaticMarkup(
    <LiveEdge finalEnabled={finalEnabled} capture={liveCapture.get()} />,
  );
}

describe("LiveEdge", () => {
  test("renders nothing when the final recorder is enabled", () => {
    expect(render(true)).toBe("");
  });

  test("keeps the existing markup when the final recorder is disabled", () => {
    expect(render(false)).toBe(
      '<div aria-hidden="true" class="live-edge" data-source="voice-note" data-tone="live"></div>',
    );
  });
});
