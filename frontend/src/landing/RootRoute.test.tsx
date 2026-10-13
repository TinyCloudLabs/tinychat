// `/` is the marketing page on the web and in the desktop app, and the app
// itself inside the native mobile shell (TC-522).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Navigate } from "react-router-dom";

import { PATHS } from "../shell/routes";
import { RootRoute } from "./RootRoute";

describe("RootRoute", () => {
  test("the native shell replaces / with Capture, the phone app's landing", () => {
    const element = RootRoute({ nativeShell: true });
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(Navigate);
    expect(element.props).toEqual({ to: "/chat/capture", replace: true });
    expect(PATHS.capture).toBe("/chat/capture");
  });

  test("the native shell never renders the landing page", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <RootRoute nativeShell />
      </MemoryRouter>,
    );
    expect(markup).not.toContain("Open app");
  });

  test("web and desktop still open on the landing page", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <RootRoute nativeShell={false} />
      </MemoryRouter>,
    );
    expect(markup).toContain("Open app");
    expect(markup).toContain('href="/chat"');
  });
});

// main.tsx calls createRoot on import, so its wiring is asserted against the
// source, as ConnectorsPage.test.tsx does for App.tsx.
describe("main.tsx routes / through RootRoute", () => {
  const main = readFileSync(join(import.meta.dir, "..", "main.tsx"), "utf8");

  test("the native flag is Capacitor's, and / renders RootRoute with it", () => {
    expect(main).toContain("const nativeShell = Capacitor.isNativePlatform();");
    expect(main).toContain('<Route path="/" element={<RootRoute nativeShell={nativeShell} />} />');
    expect(main).not.toContain("<LandingPage");
  });
});
