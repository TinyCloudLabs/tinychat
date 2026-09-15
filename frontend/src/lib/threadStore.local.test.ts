import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import * as store from "./threadStore";

test("local validation keeps every chat store operation off production SQL and KV", async () => {
  const touched: string[] = [];
  const forbidden = (name: string) => () => { touched.push(name); throw new Error(`production ${name}`); };
  const tcw = { did: "did:pkh:eip155:1:local", sql: { db: forbidden("sql") }, kv: { put: forbidden("kv") } } as unknown as TinyCloudWeb;
  expect(typeof store.useLocalThreadStorage).toBe("function");
  store.useLocalThreadStorage(tcw);
  expect(await store.listThreads(tcw)).toEqual([]);
  expect(await store.getMemory(tcw)).toBeNull();
  expect(store.readMemoryCache(tcw)).toBeNull();
  const item = { message: { id: "m1", role: "user", content: [{ type: "text", text: "Local turn" }] }, parentId: null } as store.StoredMessageItem;
  await store.appendMessage(tcw, "t1", item, store.DEFAULT_MODEL);
  await store.appendMessage(tcw, "t1", item, store.DEFAULT_MODEL);
  expect((await store.getThread(tcw, "t1"))?.messages).toHaveLength(1);
  expect(await store.getThreadTitle(tcw, "t1")).toBe("Local turn");
  expect(store.isKnownThreadId(tcw, "t1")).toBe(true);
  await store.setThreadModel(tcw, "t1", "local-model");
  expect(await store.getThreadModel(tcw, "t1")).toEqual({ status: "found", model: "local-model" });
  await store.setThreadTitle(tcw, "t1", "Renamed");
  expect((await store.listThreads(tcw))[0]?.title).toBe("Renamed");
  await store.setSetting(tcw, "k", "v");
  expect(await store.getSetting(tcw, "k")).toBe("v");
  await store.setMemory(tcw, "Local memory");
  expect(await store.getMemory(tcw)).toBe("Local memory");
  expect(store.readMemoryCache(tcw)).toBe("Local memory");
  await store.resetMemoryToTemplate(tcw);
  expect(await store.getMemory(tcw)).toContain("##");
  await store.clearMemory(tcw);
  expect(await store.getMemory(tcw)).toBeNull();
  const checkpoint = await store.appendCompaction(tcw, "t1", "m1", "Local summary");
  expect(await store.getLatestCompaction(tcw, "t1")).toEqual(checkpoint);
  await store.importThread(tcw, { id: "t2", title: "Import", createdAt: "2026-09-15", updatedAt: "2026-09-15", items: [item] });
  expect((await store.getThread(tcw, "t2"))?.messages).toHaveLength(1);
  store.clearThreadIndexCache(tcw);
  await store.deleteThread(tcw, "t1");
  expect(await store.getThread(tcw, "t1")).toBeNull();
  expect(await store.getThreadModel(tcw, "t1")).toEqual({ status: "missing" });
  expect(touched).toEqual([]);

  const other = { ...tcw } as TinyCloudWeb;
  store.useLocalThreadStorage(other);
  expect(await store.listThreads(other)).toEqual([]);
  expect(await store.getLatestCompaction(other, "t1")).toBeNull();
});

test("normal sessions retain the production store", async () => {
  let calls = 0;
  const tcw = { did: "default-regression", sql: { db: () => { calls++; throw new Error("production store selected"); } } } as unknown as TinyCloudWeb;
  await expect(store.getThread(tcw, "existing")).rejects.toThrow("production store selected");
  expect(calls).toBe(1);
});
