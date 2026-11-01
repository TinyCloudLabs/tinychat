import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RootRoute } from "../landing/RootRoute";
import { setAppsFeedEnabled } from "../lib/appsFeedFeature";
import { installDom } from "../test/dom";
import { FIRST_SCREEN_WAIT_MS, HomeEntryGate } from "./HomeEntryGate";
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
  setAppsFeedEnabled(true);
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

describe("the bounded wait (fake timers)", () => {
  const screenAt = (host: HTMLElement) => host.querySelector('[data-testid="screen"]')?.textContent ?? null;
  const tick = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });

  afterEach(() => { jest.useRealTimers(); });

  test("the window is about a second and a half", () => {
    expect(FIRST_SCREEN_WAIT_MS).toBe(1500);
  });

  test("a rejected read opens Feed at once, without waiting for the deadline", async () => {
    jest.useFakeTimers();
    const host = await mount("/", () => Promise.reject(new Error("node down")));
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("a read that throws synchronously opens Feed at once", async () => {
    jest.useFakeTimers();
    const host = await mount("/", () => { throw new Error("no account"); });
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("an unreadable stored value (anything but apps) opens Feed", async () => {
    jest.useFakeTimers();
    const host = await mount("/", async () => "garbage" as unknown as FirstScreen);
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("a read slower than the window opens Feed at the deadline and stays on Feed after it resolves to Apps", async () => {
    jest.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<FirstScreen>();
    const host = await mount("/", () => promise);
    expect(screenAt(host)).toBeNull();
    await tick(FIRST_SCREEN_WAIT_MS - 1);
    expect(screenAt(host)).toBeNull();
    await tick(1);
    expect(screenAt(host)).toBe("/chat/feed");
    await act(async () => resolve("apps"));
    await tick(FIRST_SCREEN_WAIT_MS * 4);
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("a read that resolves to Apps inside the window opens Apps", async () => {
    jest.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<FirstScreen>();
    const host = await mount("/?x=1#share=abc", () => promise);
    await tick(FIRST_SCREEN_WAIT_MS - 100);
    expect(screenAt(host)).toBeNull();
    await act(async () => resolve("apps"));
    expect(screenAt(host)).toBe("/chat/apps?x=1#share=abc");
    await tick(FIRST_SCREEN_WAIT_MS * 2);
    expect(screenAt(host)).toBe("/chat/apps?x=1#share=abc");
  });

  test("a read that never resolves opens Feed at the deadline", async () => {
    jest.useFakeTimers();
    const host = await mount("/", () => new Promise<FirstScreen>(() => {}));
    expect(screenAt(host)).toBeNull();
    await tick(FIRST_SCREEN_WAIT_MS);
    expect(screenAt(host)).toBe("/chat/feed");
  });
});

describe("one decision per entry (remounts, StrictMode, deep links)", () => {
  const screenAt = (host: HTMLElement) => host.querySelector('[data-testid="screen"]')?.textContent ?? null;
  const tick = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  let remount: () => void = () => {};

  function Remountable({ load }: { load: () => Promise<FirstScreen> }) {
    const [generation, setGeneration] = useState(0);
    remount = () => setGeneration((n) => n + 1);
    return <Screen key={generation} load={load} />;
  }

  async function mountControlled(entry: string, load: () => Promise<FirstScreen>, strict = false) {
    restore = installDom();
    setAppsFeedEnabled(true);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const tree = (
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<RootRoute nativeShell={false} homeShell />} />
          <Route path="/chat/*" element={<Remountable load={load} />} />
        </Routes>
      </MemoryRouter>
    );
    await act(async () => root!.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
    return host;
  }

  afterEach(() => { jest.useRealTimers(); });

  test("a remount after the deadline shows Feed at once and a late Apps answer never redirects", async () => {
    jest.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<FirstScreen>();
    const load = jest.fn(() => promise);
    const host = await mountControlled("/", load);
    await tick(FIRST_SCREEN_WAIT_MS);
    expect(screenAt(host)).toBe("/chat/feed");
    await act(async () => remount());
    expect(screenAt(host)).toBe("/chat/feed");
    await act(async () => resolve("apps"));
    await tick(FIRST_SCREEN_WAIT_MS * 3);
    expect(screenAt(host)).toBe("/chat/feed");
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a remount after an in-window Apps decision stays on Apps, without a loop or a second read", async () => {
    jest.useFakeTimers();
    const load = jest.fn(async (): Promise<FirstScreen> => "apps");
    const host = await mountControlled("/", load);
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/apps");
    await act(async () => remount());
    await tick(FIRST_SCREEN_WAIT_MS * 3);
    expect(screenAt(host)).toBe("/chat/apps");
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a remount while the read is still pending joins the same read and deadline", async () => {
    jest.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<FirstScreen>();
    const load = jest.fn(() => promise);
    const host = await mountControlled("/", load);
    await tick(500);
    await act(async () => remount());
    expect(screenAt(host)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => resolve("apps"));
    expect(screenAt(host)).toBe("/chat/apps");
  });

  test("StrictMode's double mount makes one read and one decision", async () => {
    jest.useFakeTimers();
    const load = jest.fn(async (): Promise<FirstScreen> => "apps");
    const host = await mountControlled("/", load, true);
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/apps");
    expect(load).toHaveBeenCalledTimes(1);
    await tick(FIRST_SCREEN_WAIT_MS * 2);
    expect(screenAt(host)).toBe("/chat/apps");
  });

  test("explicit links never read the setting and never redirect, even with Apps saved", async () => {
    jest.useFakeTimers();
    const paths = [
      "/chat", "/chat/some-thread", "/chat/feed", "/chat/apps", "/chat/connectors",
      "/chat#share=abc", "/chat/feed#share=abc", "/chat/some-thread?x=1#share=abc",
    ];
    for (const path of paths) {
      const load = jest.fn(async (): Promise<FirstScreen> => "apps");
      const host = await mountControlled(path, load);
      await act(async () => {});
      await tick(FIRST_SCREEN_WAIT_MS * 2);
      expect(screenAt(host)).toBe(path);
      expect(load).not.toHaveBeenCalled();
      await act(async () => root!.unmount());
      root = null;
      restore?.();
      restore = null;
    }
  });
});
