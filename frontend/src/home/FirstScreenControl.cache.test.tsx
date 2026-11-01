import { afterAll, afterEach, describe, expect, jest, spyOn, test, type Mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useLocalThreadStorage } from "../lib/threadStore";
import { accountStorageKey } from "../lib/voiceNotes/sourcePins";
import { installDom } from "../test/dom";
import { FIRST_SCREEN_LOAD_DEADLINE_MS, FirstScreenControl } from "./FirstScreenControl";
import * as store from "./firstScreenStore";
import { FIRST_SCREEN_CACHE_KEY, type FirstScreen } from "./firstScreenStore";
import { FIRST_SCREEN_STRINGS as text } from "./firstScreenStrings";
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
let readSpy: Mock<typeof store.readFirstScreen> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreStorage?.();
  restoreDom = restoreStorage = null;
  readSpy?.mockRestore();
  readSpy = null;
  jest.useRealTimers();
});

async function mount(tcw: TinyCloudWeb, did: string | null = DID) {
  expect(process.env.HOME).toBe(testHome);
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<FirstScreenControl tcw={tcw} did={did} />));
  return host;
}

function setup() {
  const fake = installFakeLocalStorage();
  values = fake.values;
  restoreStorage = fake.uninstall;
}

const tick = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
const choose = (host: HTMLElement, value: string) => act(async () => {
  const select = host.querySelector("select")!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
});

/** The account read is held until `release(value)`; writes go to a local account store. */
function slowRead() {
  const pending = Promise.withResolvers<FirstScreen>();
  readSpy = spyOn(store, "readFirstScreen").mockImplementation(async () => {
    const screen = await pending.promise;
    return screen;
  });
  return { tcw: useLocalThreadStorage({} as TinyCloudWeb), release: (screen: FirstScreen) => pending.resolve(screen) };
}

describe("Settings first-screen control with a slow read", () => {
  test("a cached value shows at once, with no Loading line", async () => {
    setup();
    values.set(KEY, "apps");
    jest.useFakeTimers();
    const { tcw } = slowRead();
    const host = await mount(tcw);
    expect(host.querySelector("select")?.value).toBe("apps");
    expect(host.textContent).not.toContain(text.loading);
    await tick(FIRST_SCREEN_LOAD_DEADLINE_MS * 2);
    expect(host.querySelector("select")?.value).toBe("apps");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  test("without a copy it loads, then at 8 s shows Feed, the load-error line and a usable select", async () => {
    setup();
    jest.useFakeTimers();
    const { tcw } = slowRead();
    const host = await mount(tcw);
    expect(host.textContent).toContain(text.loading);
    expect(host.querySelector("select")).toBeNull();
    await tick(FIRST_SCREEN_LOAD_DEADLINE_MS - 1);
    expect(host.querySelector("select")).toBeNull();
    await tick(1);
    expect(host.querySelector("select")?.value).toBe("feed");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(text.readError);
    expect(host.querySelector("select")?.disabled).toBe(false);
  });

  test("a late SQL result is applied if the user has not chosen, and clears the load-error line", async () => {
    setup();
    jest.useFakeTimers();
    const { tcw, release } = slowRead();
    const host = await mount(tcw);
    await tick(FIRST_SCREEN_LOAD_DEADLINE_MS);
    expect(host.querySelector("select")?.value).toBe("feed");
    await act(async () => release("apps"));
    expect(host.querySelector("select")?.value).toBe("apps");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  test("a late SQL result is ignored after the user chose", async () => {
    setup();
    jest.useFakeTimers();
    const { tcw, release } = slowRead();
    const host = await mount(tcw);
    await tick(FIRST_SCREEN_LOAD_DEADLINE_MS);
    // The user picks Feed before the late answer (Apps) arrives.
    await choose(host, "feed");
    await act(async () => release("apps"));
    expect(host.querySelector("select")?.value).toBe("feed");
  });
});
