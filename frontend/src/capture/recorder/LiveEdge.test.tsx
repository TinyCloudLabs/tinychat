import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { liveCapture } from "./liveCapture";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
});

const [{ createRoot }, { flushSync }, { LiveEdge }] = await Promise.all([
  import("react-dom/client"),
  import("react-dom"),
  import("./LiveEdge"),
]);

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  liveCapture.set(null);
  document.body.innerHTML = "";
});

function render(finalEnabled: boolean): string {
  liveCapture.set({ source: "voice-note", warning: false, startedAt: 1 });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root?.render(<LiveEdge finalEnabled={finalEnabled} />));
  return container.innerHTML;
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
