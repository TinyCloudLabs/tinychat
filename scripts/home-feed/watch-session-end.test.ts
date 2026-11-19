import { afterEach, expect, test } from "bun:test";
import type { FeedHooks } from "@tinycloud/sdk-services/feed";
import { watchHomeMirrors } from "./bridge";
import { mirrorNode, SOURCE, type MirrorNode } from "./mirror-node.fixture";

let node: MirrorNode | undefined;
afterEach(async () => { await node?.close(); node = undefined; });

/** A hooks service whose subscription finishes without being aborted, as when it releases its subscribers. */
const finishes: FeedHooks = { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) };
const options = (n: MirrorNode, hooks: FeedHooks, signal: AbortSignal) => ({
  sourceId: SOURCE, recipient: "synthetic-watch-runtime", hooks, handoff: n.ledger, deliver: async () => "delivered" as const, signal,
});

test("a hook subscription that finishes with nobody having asked the watcher to stop is a failure, not a clean exit", async () => {
  node = await mirrorNode();
  await expect(watchHomeMirrors(node.ctx, options(node, finishes, new AbortController().signal))).rejects.toBeDefined();
});

test("a watcher that was told to stop returns normally even though its subscription finished", async () => {
  node = await mirrorNode();
  const stop = new AbortController(), hooks: FeedHooks = { subscribe: (_subscriptions, subscribeOptions) => ({ [Symbol.asyncIterator]: () => ({ next: async () => {
    stop.abort(); expect(subscribeOptions?.signal?.aborted).toBe(true); return { done: true, value: undefined };
  } }) }) };
  await expect(watchHomeMirrors(node.ctx, options(node, hooks, stop.signal))).resolves.toBeUndefined();
});
