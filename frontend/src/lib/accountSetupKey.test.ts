import { expect, test } from "bun:test";
import { APP_ID } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { checkAccountSetup } from "./accountSetup";

// The sign-in's grants are `${APP_ID}/threads/` and the narrower rows beside it. The account check reads one key
// to make the first request to the node; a key outside those rows is authorised only by a broad space-root grant.
test("the account check reads a path inside TinyChat's own threads folder, never the space root", async () => {
  const keys: string[] = [];
  const tcw = { kv: { get: async (key: string) => { keys.push(key); return { ok: true }; } } } as unknown as Pick<TinyCloudWeb, "kv">;
  await checkAccountSetup(tcw);
  expect(keys).toEqual([`${APP_ID}/threads/.account-check`]);
  expect(keys[0]!.startsWith(`${APP_ID}/threads/`)).toBe(true);
});
