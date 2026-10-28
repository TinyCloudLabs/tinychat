import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useLocalThreadStorage } from "../lib/threadStore";
import { installDom } from "../test/dom";
import { FirstScreenControl } from "./FirstScreenControl";
import { readFirstScreen } from "./firstScreenStore";

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

test("Settings saves Apps to the account store and shows it when opened again", async () => {
  expect(process.env.HOME).toBe(testHome);
  restore = installDom();
  const account = useLocalThreadStorage({} as TinyCloudWeb);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<FirstScreenControl tcw={account} />));
  const select = host.querySelector("select")!;
  expect(select.value).toBe("feed");
  await act(async () => {
    select.value = "apps";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(await readFirstScreen(account)).toBe("apps");
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () => root!.render(<FirstScreenControl tcw={account} />));
  expect(host.querySelector("select")?.value).toBe("apps");
});
