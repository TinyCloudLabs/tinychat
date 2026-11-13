// TinyCloud Home's addresses (TC-2040): Feed is the default entry on every platform, and every
// existing address keeps its meaning.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { LandingRoute, RootRoute } from "@/landing/RootRoute";
import { BootSurface } from "@/shell/BootSurface";
import { HOME_PATH, legacyRedirectFor, notePath, PATHS, screenFor } from "@/shell/routes";
import { installDom } from "@/test/dom";

describe("addresses", () => {
  test("Feed and Apps are destinations; /chat and /chat/<id> are still Chat", () => {
    expect(screenFor("/chat/feed")).toEqual({ id: "feed", destination: "feed", noteId: null });
    expect(screenFor("/chat/feed/")).toEqual({ id: "feed", destination: "feed", noteId: null });
    expect(screenFor("/chat/apps")).toEqual({ id: "apps", destination: "apps", noteId: null });
    for (const path of ["/chat", "/chat/", "/chat/0b2f5c1e-1111-4222-8333-444455556666", "/chat/some-thread"]) {
      expect(screenFor(path).id).toBe("chat");
      expect(screenFor(path).destination).toBe("chat");
    }
  });

  test("recording, library, note, connectors, settings, about and legacy addresses resolve as before", () => {
    expect(screenFor(PATHS.capture).id).toBe("capture");
    expect(screenFor(PATHS.library).id).toBe("library");
    expect(screenFor(notePath("a b")).noteId).toBe("a b");
    expect(screenFor(PATHS.connectors).destination).toBe("connectors");
    expect(screenFor(PATHS.settings).id).toBe("settings");
    expect(screenFor(PATHS.about).id).toBe("about");
    expect(legacyRedirectFor("/chat/meetings")?.to).toBe(PATHS.library);
    expect(legacyRedirectFor("/chat/connectors/library")?.to).toBe(PATHS.library);
    expect(screenFor("/chat/meetings").id).toBe("library");
  });

  test("Back-home and signed-out redirects go to Feed", () => {
    expect(HOME_PATH).toBe("/chat/feed");
  });
});

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
});

function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{pathname + search + hash}</p>;
}

async function openAt(entry: string, element: React.ReactNode) {
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={element} />
          <Route path="/about" element={<LandingRoute />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  return host;
}

describe("`/` on every platform", () => {
  test("opens Feed by default, keeping the query and a #share= fragment", async () => {
    const host = await openAt("/?x=1#share=abc", <RootRoute />);
    expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/chat/feed?x=1#share=abc");
  });

  test("the landing page stays reachable at /about", async () => {
    const host = await openAt("/about", <RootRoute />);
    expect(host.textContent).toContain("Open app");
    expect(host.querySelector('[data-testid="where"]')).toBeNull();
  });
});

describe("the sign-in surface", () => {
  test("Home on the web shows the TinyCloud One sign-in heading (TC-2050) and adds a plain link to /about", () => {
    const markup = renderToStaticMarkup(<BootSurface state="unauthenticated" error={null} onAction={() => {}} home />);
    expect(markup).toContain("TinyCloud One</h1>");
    expect(markup).not.toContain("Exo</h1>");
    expect(markup).toContain('href="/about"');
    expect(markup).toContain("About TinyCloud One</a>");
  });

  test("without Home (native) it has no /about link", () => {
    const markup = renderToStaticMarkup(<BootSurface state="unauthenticated" error={null} onAction={() => {}} />);
    expect(markup).toContain("TinyCloud One</h1>");
    expect(markup).not.toContain("/about");
  });
});

describe("main.tsx", () => {
  const main = readFileSync(join(import.meta.dir, "..", "main.tsx"), "utf8");
  test("registers /about for the landing page and keeps /chat/* mounted as App", () => {
    expect(main).toContain('<Route path="/about" element={<LandingRoute />} />');
  });
});
