import { expect, test } from "bun:test";
import { BACKEND_KV_ROOTS } from "../backend-kv-roots.js";
import { DELETED_MEETING_KEY_PREFIX } from "../routes/connector-webhooks.js";

test("backend grants include deleted-meeting marker keys", () => {
  expect(BACKEND_KV_ROOTS).toContain(DELETED_MEETING_KEY_PREFIX);
});
