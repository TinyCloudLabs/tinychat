// Agent-host Fireflies runner (TC-3804): once the owner's Sync now reseals FIREFLIES_API_KEY to its own key, a key
// profile without an exact-key grant gets DECRYPT_DENIED. The runner reports needs_renewal (it needs that grant),
// not a generic error.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readKeyWithCli } from "../../scripts/agent-sync/fireflies";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-sync-key-read-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `tc` that fails `secrets get` with `code`, as the CLI prints it on stderr. */
function failingCli(code: string): string {
  const path = join(dir, "tc");
  writeFileSync(path, `#!/bin/sh\necho '{"ok":false,"error":{"code":"${code}","message":"denied"}}' >&2\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

async function failure(code: string): Promise<{ result: string; message: string }> {
  try {
    await readKeyWithCli(failingCli(code), "key-profile");
  } catch (error) {
    return { result: (error as { result: string }).result, message: (error as Error).message };
  }
  throw new Error("the read did not fail");
}

test("a key sealed to its own key, read without that key's grant, needs renewal", async () => {
  expect(await failure("DECRYPT_DENIED")).toEqual({ result: "needs_renewal", message: "secrets get: DECRYPT_DENIED" });
});

test("an unknown failure is still an error", async () => {
  expect(await failure("NODE_NOT_RESPONDING")).toEqual({ result: "error", message: "secrets get: NODE_NOT_RESPONDING" });
});
