// The page side of test/home-feed-outbox.e2e.test.ts: the real Home feed (FeedViewEntries over the real
// createHomeFeedSource) in a real browser. Only the SDK transport is replaced: every SQL call goes
// to the test's server, which runs it on SQLite and can hold a write back to stand in for a slow
// node. Home mounts only when the test asks, so the outbox can be read first.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import { FeedViewEntries } from "@/feed/FeedView";
import { createHomeFeedSource } from "@/feed/feedStore";
import { useLocalThreadStorage } from "@/lib/threadStore";

const space = new URLSearchParams(location.search).get("space") ?? "";

async function call(body: Record<string, unknown>) {
  const response = await fetch("/sql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space, ...body }) });
  return response.json();
}
function remote(resource: string): FeedDatabase {
  return {
    query: (sql, params = []) => call({ resource, op: "query", sql, params }),
    execute: (sql, params = []) => call({ resource, op: "execute", sql, params }),
    batch: (statements) => call({ resource, op: "batch", statements }),
  } as FeedDatabase;
}
// No live updates: the subscription yields nothing and ends when Home closes it.
const hooks = {
  subscribe(_subscriptions: unknown, options?: { signal?: AbortSignal; onReady?: () => void }): AsyncIterableIterator<never> {
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        options?.onReady?.();
        // The app's TypeScript lib predates Promise.withResolvers.
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
        return { done: true, value: undefined };
      },
    };
  },
};
const tcw = useLocalThreadStorage({ spaceId: space, did: `did:pkh:eip155:1:${space}`, hooks, sql: { db: remote } } as unknown as TinyCloudWeb);

const api = {
  /** The page-close outbox's entries, read before Home mounts. */
  outbox(): Record<string, string> {
    const entries: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (key.startsWith("tinychat.home.answer-outbox.v1:")) entries[key] = localStorage.getItem(key)!;
    }
    return entries;
  },
  mount() {
    const host = document.createElement("div");
    document.body.append(host);
    createRoot(host).render(createElement(MemoryRouter, null, createElement(FeedViewEntries, { realEntries: [], source: createHomeFeedSource(tcw) })));
  },
};

export type OutboxPageApi = typeof api;
(window as unknown as { harness: OutboxPageApi }).harness = api;
