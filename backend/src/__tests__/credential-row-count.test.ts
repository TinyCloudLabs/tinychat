// TC-1964: the optional startup credential row count is read-only, count-only and never fatal.
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import {
  CREDENTIAL_ROW_COUNT_INVALID_SOURCE,
  CREDENTIAL_ROW_COUNT_LIST_FAILED,
  logCredentialRowCounts,
} from "../services/credential-row-count.js";
import { KvCredentialRowStore } from "../services/credential-store.js";

// Never touch a real home.
const tmpHome = mkdtempSync("/var/tmp/TC-1964.");
const savedHome = process.env.HOME;
const savedCache = process.env.BUN_INSTALL_CACHE_DIR;
process.env.HOME = tmpHome;
process.env.BUN_INSTALL_CACHE_DIR = tmpHome;
if (!process.env.HOME.startsWith("/var/tmp/TC-1964.")) throw new Error("unsafe HOME");

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR;
  else process.env.BUN_INSTALL_CACHE_DIR = savedCache;
  rmSync(tmpHome, { recursive: true, force: true });
});

const ADDR_A = `0x${"a".repeat(40)}`;
const ADDR_B = `0x${"b".repeat(40)}`;
const SECRET = "SEALED-CIPHERTEXT-MARKER";

function fakeNode(opts: { keys?: string[]; listResult?: unknown; listThrows?: boolean } = {}) {
  const calls: string[] = [];
  const keys = opts.keys ?? [];
  const boom = () => {
    throw new Error(`forbidden call; key leak ${ADDR_A} ${SECRET}`);
  };
  const node = {
    kv: {
      async list({ prefix }: { prefix: string }) {
        calls.push(`list:${prefix}`);
        if (opts.listThrows) throw new Error(`list failed for ${ADDR_A} ${SECRET}`);
        if (opts.listResult !== undefined) return opts.listResult;
        return { ok: true, data: { keys: keys.filter((k) => k.startsWith(prefix)) } };
      },
      get: boom,
      put: boom,
      delete: boom,
    },
  } as unknown as TinyCloudNode;
  return { node, calls };
}

async function run(raw: string | undefined, node: TinyCloudNode) {
  const lines: string[] = [];
  let built = 0;
  await logCredentialRowCounts(
    raw,
    () => {
      built += 1;
      return new KvCredentialRowStore(node, new BackendStorageLane(), { priority: "background" });
    },
    (line) => lines.push(line),
  );
  return { lines, built };
}

describe("TC-1964 credential row count", () => {
  test("counts rows under the source prefix without reading values", async () => {
    const { node, calls } = fakeNode({
      keys: [
        `credentials/fireflies/${ADDR_A}`,
        `credentials/fireflies/${ADDR_B}`,
        `credentials/google/${ADDR_A}`,
      ],
    });
    const { lines } = await run("fireflies", node);
    expect(lines).toEqual(["credential_row_count source=fireflies count=2"]);
    expect(calls).toEqual(["list:credentials/fireflies/"]);
  });

  test("counts zero rows", async () => {
    const { node } = fakeNode();
    const { lines } = await run("fireflies", node);
    expect(lines).toEqual(["credential_row_count source=fireflies count=0"]);
  });

  test("counts a large listing exactly", async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `credentials/fireflies/0x${i.toString(16).padStart(40, "0")}`);
    const { node } = fakeNode({ keys });
    const { lines } = await run("fireflies", node);
    expect(lines).toEqual(["credential_row_count source=fireflies count=2500"]);
  });

  test("one line per listed source, in order, de-duplicated", async () => {
    const { node, calls } = fakeNode({ keys: [`credentials/fireflies/${ADDR_A}`, `credentials/google/${ADDR_A}`] });
    const { lines } = await run(" fireflies , google,fireflies,,", node);
    expect(lines).toEqual([
      "credential_row_count source=fireflies count=1",
      "credential_row_count source=google count=1",
    ]);
    expect(calls).toEqual(["list:credentials/fireflies/", "list:credentials/google/"]);
  });

  test("unset, empty or blank runs nothing: no store, no KV call", async () => {
    for (const raw of [undefined, "", "   ", " , ,"]) {
      const { node, calls } = fakeNode();
      const { lines, built } = await run(raw, node);
      expect(lines).toEqual([]);
      expect(built).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  test("a failing list logs count=unavailable with the fixed code and does not throw", async () => {
    const { node } = fakeNode({ listThrows: true });
    const { lines } = await run("fireflies", node);
    expect(CREDENTIAL_ROW_COUNT_LIST_FAILED).toBe("LIST_FAILED");
    expect(lines).toEqual(["credential_row_count source=fireflies count=unavailable code=LIST_FAILED"]);
  });

  test("an ok:false or malformed listing is unavailable, not a count", async () => {
    for (const listResult of [
      { ok: false, error: { code: "KV_ERROR", message: `secret ${ADDR_A}` } },
      { ok: true, data: {} },
      { ok: true, data: { keys: "nope" } },
    ]) {
      const { node } = fakeNode({ listResult });
      const { lines } = await run("fireflies", node);
      expect(lines).toEqual(["credential_row_count source=fireflies count=unavailable code=LIST_FAILED"]);
    }
  });

  test("a store that cannot be built is unavailable, not a crash", async () => {
    const lines: string[] = [];
    await logCredentialRowCounts(
      "fireflies",
      () => {
        throw new Error("no node");
      },
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["credential_row_count source=fireflies count=unavailable code=LIST_FAILED"]);
  });

  test("invalid source names are never echoed and never listed", async () => {
    const { node, calls } = fakeNode();
    const { lines } = await run("Fire/../flies,../x", node);
    expect(CREDENTIAL_ROW_COUNT_INVALID_SOURCE).toBe("INVALID_SOURCE");
    expect(lines).toEqual([
      "credential_row_count source=invalid count=unavailable code=INVALID_SOURCE",
      "credential_row_count source=invalid count=unavailable code=INVALID_SOURCE",
    ]);
    expect(calls).toEqual([]);
  });

  test("a valid source is still counted next to an invalid one", async () => {
    const { node } = fakeNode({ keys: [`credentials/fireflies/${ADDR_A}`] });
    const { lines } = await run("BAD NAME,fireflies", node);
    expect(lines).toEqual([
      "credential_row_count source=invalid count=unavailable code=INVALID_SOURCE",
      "credential_row_count source=fireflies count=1",
    ]);
  });

  test("log output has only the permitted shape and leaks no key, address or error text", async () => {
    const shape = /^credential_row_count source=[a-z0-9-]{1,32} count=(\d+|unavailable code=[A-Z_]+)$/;
    const ok = fakeNode({ keys: [`credentials/fireflies/${ADDR_A}`, `credentials/fireflies/${ADDR_B}`] });
    const bad = fakeNode({ listThrows: true });
    const lines = [
      ...(await run("fireflies,Bad Name", ok.node)).lines,
      ...(await run("fireflies", bad.node)).lines,
    ];
    expect(lines.length).toBe(3);
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const printed: string[] = [];
    console.log = (...a: unknown[]) => void printed.push(a.join(" "));
    console.warn = (...a: unknown[]) => void printed.push(a.join(" "));
    console.error = (...a: unknown[]) => void printed.push(a.join(" "));
    try {
      // Default logger path (console.log) too.
      await logCredentialRowCounts("fireflies", () => new KvCredentialRowStore(ok.node, new BackendStorageLane()));
      await logCredentialRowCounts("fireflies", () => new KvCredentialRowStore(bad.node, new BackendStorageLane()));
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
    for (const line of [...lines, ...printed]) {
      expect(line).toMatch(shape);
      expect(line).not.toContain(ADDR_A);
      expect(line).not.toContain(ADDR_B);
      expect(line).not.toContain("0x");
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("credentials/");
    }
    expect(printed).toEqual([
      "credential_row_count source=fireflies count=2",
      "credential_row_count source=fireflies count=unavailable code=LIST_FAILED",
    ]);
  });

  test("countRows returns a bare number and runs through the shared lane", async () => {
    const { node, calls } = fakeNode({ keys: [`credentials/fireflies/${ADDR_A}`] });
    const lane = new BackendStorageLane();
    const gate = Promise.withResolvers<void>();
    const first = lane.run(() => gate.promise);
    const counted = new KvCredentialRowStore(node, lane).countRows("fireflies");
    // Queued behind the running lane job: no KV call until it releases the lane.
    await Promise.resolve();
    expect(calls).toEqual([]);
    gate.resolve();
    await first;
    expect(await counted).toBe(1);
    expect(calls).toEqual(["list:credentials/fireflies/"]);
  });
});
