import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { installDom } from "@/test/dom";
import { StaticRecorderProvider } from "./RecorderProvider";
import { CaptureSourceUnconfirmedIndicator } from "./CaptureSourceUnconfirmedIndicator";

let cleanupDom: (() => void) | undefined;
let root: Root | undefined;

function RouteLocation() {
  return <output data-testid="route">{useLocation().pathname}</output>;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  cleanupDom?.();
  cleanupDom = undefined;
});

test("warning remains across navigation and disappears when native status clears it", async () => {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (captureSourceUnconfirmed: boolean) => act(async () => root!.render(
    <StaticRecorderProvider value={{ captureSourceUnconfirmed }}>
      <MemoryRouter>
        <CaptureSourceUnconfirmedIndicator />
        <Link to="/library">Library</Link>
        <Routes>
          <Route path="/" element={<RouteLocation />} />
          <Route path="/library" element={<RouteLocation />} />
        </Routes>
      </MemoryRouter>
    </StaticRecorderProvider>,
  ));

  await render(true);
  expect(host.querySelector('[data-testid="capture-source-unconfirmed"]')?.textContent).toContain("The recording was saved.");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => host.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  expect(host.querySelector('[data-testid="route"]')?.textContent).toBe("/library");
  expect(host.querySelector('[data-testid="capture-source-unconfirmed"]')).not.toBeNull();

  await render(false);
  expect(host.querySelector('[data-testid="capture-source-unconfirmed"]')).toBeNull();
});
