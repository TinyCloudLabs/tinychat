import { expect, test } from "bun:test";
import { deleteFirefliesWithLedger } from "./deleteFirefliesWithLedger";

test("backend rejection leaves the Fireflies meeting untouched", async () => {
  let localDeletes = 0;
  const result = await deleteFirefliesWithLedger(
    async () => ({ status: "retryable" as const, httpStatus: 503, code: null }),
    async () => { localDeletes++; return { ok: true as const, data: undefined }; },
    "fireflies-id",
  );
  expect(result.ok).toBe(false);
  expect(localDeletes).toBe(0);
});

test("backend recording precedes local Fireflies deletion", async () => {
  const order: string[] = [];
  const result = await deleteFirefliesWithLedger(
    async () => { order.push("backend"); return { status: "ok" as const, data: null }; },
    async () => { order.push("local"); return { ok: true as const, data: undefined }; },
    "fireflies-id",
  );
  expect(result.ok).toBe(true);
  expect(order).toEqual(["backend", "local"]);
});
