import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useLocalThreadStorage } from "../lib/threadStore";
import { readFirstScreen, writeFirstScreen } from "./firstScreenStore";
const testHome = mkdtempSync(join("/var/tmp", "TC-2040."));
for (const name of ["HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TC_PROFILE_DIR"]) process.env[name] = testHome;
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("first screen in the account settings store", () => {
  test("defaults to Feed and a saved Apps choice survives a fresh read", async () => {
    expect(process.env.HOME).toBe(testHome);
    const account = useLocalThreadStorage({} as TinyCloudWeb);
    expect(await readFirstScreen(account)).toBe("feed");
    await writeFirstScreen(account, "apps");
    expect(await readFirstScreen(account)).toBe("apps");
    await writeFirstScreen(account, "feed");
    expect(await readFirstScreen(account)).toBe("feed");
  });
});
