// `/` opens TinyCloud Home's first screen on every platform: the web, the
// desktop app and the native mobile shell (TC-2040, TC-2050).

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { installDom } from "../test/dom";
import { RootRoute } from "./RootRoute";

let root: Root | null = null;
let restoreDom: (() => void) | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
});

function Where() {
  const { pathname, search, hash, state } = useLocation();
  return <p data-entry={String((state as { homeEntry?: boolean } | null)?.homeEntry === true)}>{pathname + search + hash}</p>;
}

async function open(entry: string) {
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<RootRoute />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  ));
  return host.innerHTML;
}

describe("RootRoute", () => {
  test("replaces / with Feed, marked as a Home entry so the first-screen choice applies", async () => {
    expect(await open("/")).toBe('<p data-entry="true">/chat/feed</p>');
  });

  test("keeps the query and a #share= fragment", async () => {
    expect(await open("/?x=1#share=abc")).toBe('<p data-entry="true">/chat/feed?x=1#share=abc</p>');
  });
});

// main.tsx calls createRoot on import, so its wiring is asserted against the
// source, as ConnectorsPage.test.tsx does for App.tsx.
describe("main.tsx routes / through RootRoute on every platform", () => {
  const main = readFileSync(join(import.meta.dir, "..", "main.tsx"), "utf8");

  test("/ renders RootRoute with no platform switch, and /chat/* mounts App directly", () => {
    expect(main).toContain('<Route path="/" element={<RootRoute />} />');
    expect(main).toContain('<Route path="/chat/*" element={<CaptureEngineGate><App /></CaptureEngineGate>} />');
    expect(main).not.toContain("<LandingPage");
  });
});
