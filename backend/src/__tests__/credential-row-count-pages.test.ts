// TC-1964: the credential row count follows every list page and fails closed; source validation
// is the store's own. A truncated listing must never yield a (falsely low) number.
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import {
  CREDENTIAL_ROW_COUNT_MAX_PAGES,
  CredentialRowCountError,
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

interface Page {
  keys: string[];
  truncated?: boolean;
  nextCursor?: string;
}

const row = (i: number) => `credentials/fireflies/0x${i.toString(16).padStart(40, "0")}`;
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i));

/** A node whose list serves `pages` by cursor ("" = first page). get/put/delete must never run. */
function pagedNode(pages: (cursor: string) => Page | undefined) {
  const requests: Array<{ prefix: string; cursor: string | undefined }> = [];
  const forbidden = () => {
    throw new Error("forbidden KV call");
  };
  const node = {
    kv: {
      async list(options: { prefix: string; cursor?: string }) {
        requests.push({ prefix: options.prefix, cursor: options.cursor });
        const page = pages(options.cursor ?? "");
        if (!page) return { ok: false, error: { code: "KV_ERROR", message: "unknown cursor" } };
        return { ok: true, data: page };
      },
      get: forbidden,
      put: forbidden,
      delete: forbidden,
    },
  } as unknown as TinyCloudNode;
  return { node, requests };
}

const store = (node: TinyCloudNode) => new KvCredentialRowStore(node, new BackendStorageLane());

async function lines(raw: string, node: TinyCloudNode): Promise<string[]> {
  const out: string[] = [];
  await logCredentialRowCounts(raw, () => store(node), (line) => out.push(line));
  return out;
}

describe("TC-1964 credential row count pagination", () => {
  test("multi-page listing sums exactly and follows each cursor in order", async () => {
    const chain: Record<string, Page> = {
      "": { keys: rows(0, 3), truncated: true, nextCursor: "c1" },
      c1: { keys: rows(3, 4), truncated: true, nextCursor: "c2" },
      c2: { keys: rows(7, 2), truncated: false },
    };
    const { node, requests } = pagedNode((cursor) => chain[cursor]);
    expect(await store(node).countRows("fireflies")).toBe(9);
    expect(requests).toEqual([
      { prefix: "credentials/fireflies/", cursor: undefined },
      { prefix: "credentials/fireflies/", cursor: "c1" },
      { prefix: "credentials/fireflies/", cursor: "c2" },
    ]);
    expect(await lines("fireflies", node)).toEqual(["credential_row_count source=fireflies count=9"]);
  });

  test("a page with a cursor but no truncated flag is still followed", async () => {
    const chain: Record<string, Page> = {
      "": { keys: rows(0, 1), nextCursor: "c1" },
      c1: { keys: rows(1, 1) },
    };
    const { node } = pagedNode((cursor) => chain[cursor]);
    expect(await store(node).countRows("fireflies")).toBe(2);
  });

  test("empty listing is zero", async () => {
    const { node, requests } = pagedNode(() => ({ keys: [] }));
    expect(await store(node).countRows("fireflies")).toBe(0);
    expect(requests.length).toBe(1);
    expect(await lines("fireflies", node)).toEqual(["credential_row_count source=fireflies count=0"]);
  });

  test("truncated without a usable cursor is unavailable LIST_TRUNCATED, never a partial number", async () => {
    for (const page of [
      { keys: rows(0, 5), truncated: true },
      { keys: rows(0, 5), truncated: true, nextCursor: "" },
    ] as Page[]) {
      const { node } = pagedNode(() => page);
      await expect(store(node).countRows("fireflies")).rejects.toBeInstanceOf(CredentialRowCountError);
      expect(await lines("fireflies", node)).toEqual([
        "credential_row_count source=fireflies count=unavailable code=LIST_TRUNCATED",
      ]);
    }
  });

  test("truncation on a later page fails the whole count", async () => {
    const chain: Record<string, Page> = {
      "": { keys: rows(0, 3), truncated: true, nextCursor: "c1" },
      c1: { keys: rows(3, 3), truncated: true },
    };
    const { node } = pagedNode((cursor) => chain[cursor]);
    expect(await lines("fireflies", node)).toEqual([
      "credential_row_count source=fireflies count=unavailable code=LIST_TRUNCATED",
    ]);
  });

  test("a repeated cursor cannot loop: unavailable LIST_TRUNCATED", async () => {
    const { node, requests } = pagedNode(() => ({ keys: rows(0, 1), truncated: true, nextCursor: "same" }));
    expect(await lines("fireflies", node)).toEqual([
      "credential_row_count source=fireflies count=unavailable code=LIST_TRUNCATED",
    ]);
    expect(requests.length).toBe(2);
  });

  test("the page cap fails closed with LIST_TRUNCATED", async () => {
    let n = 0;
    const { node, requests } = pagedNode(() => ({ keys: rows(n, 1), truncated: true, nextCursor: `c${++n}` }));
    await expect(store(node).countRows("fireflies", 5)).rejects.toMatchObject({ code: "LIST_TRUNCATED" });
    expect(requests.length).toBe(5);
    // Default cap is the documented bound, and the default path also reports the fixed code.
    expect(CREDENTIAL_ROW_COUNT_MAX_PAGES).toBe(1000);
    const out = await lines("fireflies", node);
    expect(out).toEqual(["credential_row_count source=fireflies count=unavailable code=LIST_TRUNCATED"]);
    expect(requests.length).toBe(5 + CREDENTIAL_ROW_COUNT_MAX_PAGES);
  });

  test("cursors and keys never reach the log", async () => {
    const chain: Record<string, Page> = {
      "": { keys: rows(0, 2), truncated: true, nextCursor: "SECRET-CURSOR-VALUE" },
      "SECRET-CURSOR-VALUE": { keys: rows(2, 1), truncated: true },
    };
    const { node } = pagedNode((cursor) => chain[cursor]);
    const out = await lines("fireflies", node);
    for (const line of out) {
      expect(line).not.toContain("SECRET-CURSOR-VALUE");
      expect(line).not.toContain("0x");
      expect(line).not.toContain("credentials/");
    }
  });

  test("a failing later page is LIST_FAILED, not a partial number", async () => {
    const { node } = pagedNode((cursor) => (cursor === "" ? { keys: rows(0, 2), nextCursor: "c1" } : undefined));
    expect(await lines("fireflies", node)).toEqual([
      "credential_row_count source=fireflies count=unavailable code=LIST_FAILED",
    ]);
  });
});

describe("TC-1964 credential row count source validation (the store's own rules)", () => {
  test("sources failing the store's validator are INVALID_SOURCE and never listed", async () => {
    for (const bad of ["-a", "Fireflies", "FIREFLIES", "a_b", "a b", "../x", "a/b", "x".repeat(33)]) {
      const { node, requests } = pagedNode(() => ({ keys: rows(0, 1) }));
      expect(await lines(bad, node)).toEqual([
        "credential_row_count source=invalid count=unavailable code=INVALID_SOURCE",
      ]);
      await expect(store(node).countRows(bad)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
      expect(requests).toEqual([]);
    }
  });

  test("empty and blank entries run nothing at all", async () => {
    for (const raw of ["", "   ", ",", " , "]) {
      const { node, requests } = pagedNode(() => ({ keys: rows(0, 1) }));
      expect(await lines(raw, node)).toEqual([]);
      expect(requests).toEqual([]);
    }
  });

  test("known and pattern-valid sources are listed under their own prefix", async () => {
    // `calendar` is valid under the store's rule (^[a-z0-9][a-z0-9-]{0,31}$): it lists an
    // (empty) prefix and reports 0; only the store's validator gates names.
    for (const source of ["fireflies", "google-meet", "google-calendar", "calendar"]) {
      const { node, requests } = pagedNode(() => ({ keys: [] }));
      expect(await lines(source, node)).toEqual([`credential_row_count source=${source} count=0`]);
      expect(requests).toEqual([{ prefix: `credentials/${source}/`, cursor: undefined }]);
    }
  });
});
