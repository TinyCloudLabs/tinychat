import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { __resetStorageStatusForTests, reportStorageError, reportStorageWriteSucceeded } from "@/lib/storageStatus";
import { installDom } from "@/test/dom";
import { NavRail } from "./NavRail";
import { navItems } from "./navItems";
import { PATHS } from "./routes";
import { Sidebar } from "./Sidebar";

const navProps = { items: navItems(0), current: null, replace: false, onReselect: () => {}, settings: true };

const settingsDot = (host: HTMLElement) =>
  host.querySelector(`a[href="${PATHS.settings}"] [aria-label="Storage full"]`);

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={[PATHS.settings]}>{node}</MemoryRouter>));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
  await __resetStorageStatusForTests();
});

describe("the Settings destination's storage-full dot", () => {
  test("the sidebar shows it while storage is read-only, and clears once a write succeeds", async () => {
    const host = await mount(<Sidebar {...navProps} />);
    expect(settingsDot(host)).toBeNull();
    await act(async () => reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED" }));
    expect(settingsDot(host)).not.toBeNull();
    await act(async () => reportStorageWriteSucceeded());
    expect(settingsDot(host)).toBeNull();
  });

  test("the nav rail shows it while storage is read-only, and clears once a write succeeds", async () => {
    const host = await mount(<NavRail {...navProps} />);
    expect(settingsDot(host)).toBeNull();
    await act(async () => reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED" }));
    expect(settingsDot(host)).not.toBeNull();
    await act(async () => reportStorageWriteSucceeded());
    expect(settingsDot(host)).toBeNull();
  });
});
