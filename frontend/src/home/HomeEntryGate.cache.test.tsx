import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { RootRoute } from "../landing/RootRoute";
import { setAppsFeedEnabled } from "../lib/appsFeedFeature";
import { useLocalThreadStorage } from "../lib/threadStore";
import { accountStorageKey } from "../lib/voiceNotes/sourcePins";
import { installDom } from "../test/dom";
import { FIRST_SCREEN_WAIT_MS, HomeEntryGate } from "./HomeEntryGate";
import { FIRST_SCREEN_CACHE_KEY, readCachedFirstScreen, readFirstScreen, writeFirstScreen, type FirstScreen } from "./firstScreenStore";
import { installFakeLocalStorage } from "./firstScreenTestStorage";

const testHome = mkdtempSync(join("/var/tmp", "TC-2079."));
for (const name of ["HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TC_PROFILE_DIR"]) process.env[name] = testHome;
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const DID = "did:a";
const KEY = accountStorageKey(FIRST_SCREEN_CACHE_KEY, DID);
let root: Root | null = null;
let restoreDom: (() => void) | null = null;
let restoreStorage: (() => void) | null = null;
let values = new Map<string, string>();
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreStorage?.();
  restoreDom = restoreStorage = null;
  jest.useRealTimers();
});

function useStorage(options?: { throwing?: boolean }) {
  const fake = installFakeLocalStorage(options);
  values = fake.values;
  restoreStorage = fake.uninstall;
}

const cached = () => readCachedFirstScreen(DID);
const screenAt = (host: HTMLElement) => host.querySelector('[data-testid="screen"]')?.textContent ?? null;
const tick = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });

function Screen({ load }: { load: () => Promise<FirstScreen> }) {
  const { pathname } = useLocation();
  return <HomeEntryGate load={load} cached={cached}><p data-testid="screen">{pathname}</p></HomeEntryGate>;
}

async function mount(load: () => Promise<FirstScreen>) {
  expect(process.env.HOME).toBe(testHome);
  restoreDom = installDom();
  setAppsFeedEnabled(true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<RootRoute nativeShell={false} homeShell />} />
        <Route path="/chat/*" element={<Screen load={load} />} />
      </Routes>
    </MemoryRouter>,
  ));
  return host;
}

describe("Home entry with a device-local copy of the choice", () => {
  test("cached Apps opens Apps at once, before the SQL read resolves and without any timer", async () => {
    useStorage();
    values.set(KEY, "apps");
    jest.useFakeTimers();
    const { promise } = Promise.withResolvers<FirstScreen>();
    const load = jest.fn(() => promise);
    const host = await mount(load);
    expect(screenAt(host)).toBe("/chat/apps");
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("cached Feed opens Feed at once while the read is pending", async () => {
    useStorage();
    values.set(KEY, "feed");
    jest.useFakeTimers();
    const host = await mount(() => new Promise<FirstScreen>(() => {}));
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("no copy and a read slower than the window still opens Feed at the deadline", async () => {
    useStorage();
    jest.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<FirstScreen>();
    const host = await mount(() => promise);
    expect(screenAt(host)).toBeNull();
    await tick(FIRST_SCREEN_WAIT_MS - 1);
    expect(screenAt(host)).toBeNull();
    await tick(1);
    expect(screenAt(host)).toBe("/chat/feed");
    await act(async () => resolve("apps"));
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("a later SQL answer refreshes the copy but never moves the user", async () => {
    useStorage();
    values.set(KEY, "feed");
    jest.useFakeTimers();
    const account = useLocalThreadStorage({} as TinyCloudWeb);
    await writeFirstScreen(account, "apps");
    const slow = Promise.withResolvers<void>();
    const host = await mount(async () => { await slow.promise; return readFirstScreen(account, DID); });
    expect(screenAt(host)).toBe("/chat/feed");
    expect(values.get(KEY)).toBe("feed");
    await act(async () => slow.resolve());
    await tick(FIRST_SCREEN_WAIT_MS * 4);
    expect(values.get(KEY)).toBe("apps");
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("a failing read with a copy still opens from the copy", async () => {
    useStorage();
    values.set(KEY, "apps");
    jest.useFakeTimers();
    const host = await mount(() => Promise.reject(new Error("node down")));
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/apps");
  });

  test("a corrupt copy is ignored: today's wait and Feed fallback apply", async () => {
    useStorage();
    values.set(KEY, "garbage");
    jest.useFakeTimers();
    const host = await mount(() => new Promise<FirstScreen>(() => {}));
    expect(screenAt(host)).toBeNull();
    await tick(FIRST_SCREEN_WAIT_MS);
    expect(screenAt(host)).toBe("/chat/feed");
  });

  test("storage that throws is ignored: a read inside the window still decides", async () => {
    useStorage({ throwing: true });
    jest.useFakeTimers();
    const host = await mount(async () => "apps");
    await act(async () => {});
    expect(screenAt(host)).toBe("/chat/apps");
  });
});
