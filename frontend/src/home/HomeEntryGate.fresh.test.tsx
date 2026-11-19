import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RootRoute } from "../landing/RootRoute";
import { installDom } from "../test/dom";
import { HomeEntryGate } from "./HomeEntryGate";
import type { FirstScreen } from "./firstScreenStore";

const testHome = mkdtempSync(join("/var/tmp", "TC-2146."));
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
  expect(window.localStorage.length).toBe(0);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<RootRoute />} />
        <Route path="/chat/*" element={<Screen load={load} />} />
      </Routes>
    </MemoryRouter>,
  ));
  return host;
}

// A fresh install: nothing stored on the device and no choice saved. `/` opens Feed on every platform (TC-2050).
test("on a fresh install, / reads the unset choice and opens Feed", async () => {
  const load = jest.fn(async (): Promise<FirstScreen> => "feed");
  const host = await mount("/", load);
  await act(async () => {});
  expect(host.querySelector('[data-testid="screen"]')?.textContent).toBe("/chat/feed");
  expect(load).toHaveBeenCalledTimes(1);
});

test("on a fresh install, a saved Apps choice from another device still wins", async () => {
  const load = jest.fn(async (): Promise<FirstScreen> => "apps");
  const host = await mount("/", load);
  await act(async () => {});
  expect(host.querySelector('[data-testid="screen"]')?.textContent).toBe("/chat/apps");
});
