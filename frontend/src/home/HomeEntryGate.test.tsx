import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RootRoute } from "../landing/RootRoute";
import { installDom } from "../test/dom";
import { HomeEntryGate } from "./HomeEntryGate";
import type { FirstScreen } from "./firstScreenStore";
const testHome = mkdtempSync(join("/var/tmp", "TC-2040."));
for (const name of ["HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TC_PROFILE_DIR"]) process.env[name] = testHome;
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

let root: Root | null = null;
let restore: (() => void) | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restore?.();
  restore = null;
});

function Screen({ load }: { load: () => Promise<FirstScreen> }) {
  const { pathname, search, hash } = useLocation();
  return <HomeEntryGate load={load}><p data-testid="screen">{pathname + search + hash}</p></HomeEntryGate>;
}

async function mount(entry: string, load: () => Promise<FirstScreen>) {
  expect(process.env.HOME).toBe(testHome);
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<RootRoute nativeShell={false} homeShell />} />
        <Route path="/chat/*" element={<Screen load={load} />} />
      </Routes>
    </MemoryRouter>,
  ));
  return host;
}

describe("Home ordinary entry", () => {
  test("Apps choice redirects / only and preserves query and fragment", async () => {
    const host = await mount("/?x=1#share=abc", async () => "apps");
    expect(host.querySelector('[data-testid="screen"]')?.textContent).toBe("/chat/apps?x=1#share=abc");
  });

  test("does not show Feed while the saved choice is loading", async () => {
    const { promise, resolve } = Promise.withResolvers<FirstScreen>();
    const host = await mount("/", () => promise);
    expect(host.querySelector('[data-testid="screen"]')).toBeNull();
    await act(async () => resolve("apps"));
    expect(host.querySelector('[data-testid="screen"]')?.textContent).toBe("/chat/apps");
  });

  test("unset choice opens Feed without a second redirect", async () => {
    const host = await mount("/", async () => "feed");
    expect(host.querySelector('[data-testid="screen"]')?.textContent).toBe("/chat/feed");
  });

  test("explicit Chat, Feed and Apps deep links never wait for or read the choice", async () => {
    for (const path of ["/chat", "/chat/feed", "/chat/apps"]) {
      const load = () => { throw new Error("deep link must not load the preference"); };
      const host = await mount(path, load);
      expect(host.querySelector('[data-testid="screen"]')?.textContent).toBe(path);
      await act(async () => root!.unmount());
      root = null;
      restore?.();
      restore = null;
    }
  });
});
