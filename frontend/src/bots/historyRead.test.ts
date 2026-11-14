import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { HISTORY_READ_CONCURRENCY, readBotHistory } from "./historyRead";

const ADDRESS = "0x00000000000000000000000000000000000a11ce";
const OWNER = `did:pkh:eip155:1:${ADDRESS}`;
const SPACE = makePkhSpaceId(ADDRESS, 1, "applications");

async function historyPrefix(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(OWNER));
  return `xyz.tinycloud.tinychat/threads/bots/v1/${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}/`;
}

/** A thread of `count` stored records; each decrypt waits until the test releases it. */
async function storedThread(count: number, options: { corrupt?: number } = {}) {
  const prefix = await historyPrefix();
  const records = Array.from({ length: count }, (_, seq) => {
    const key = `${prefix}1/${seq}-c${seq}`;
    const batch = { generation: 1, seq, challenge: `c${seq}`, record: { type: seq % 2 ? "assistant" : "user", text: `m${seq}`, at: `2026-11-14T00:00:${String(seq).padStart(2, "0")}Z` } };
    return { key, aad: btoa(JSON.stringify({ owner: OWNER, spaceId: SPACE, path: key })), batch };
  });
  if (options.corrupt !== undefined) records[options.corrupt]!.batch.seq = 999;
  const pending: Array<() => void> = [];
  const state = { inFlight: 0, peak: 0, started: 0, aborted: 0 };
  const tcw = {
    session: () => ({ address: ADDRESS, chainId: 1 }),
    kvForSpace: () => ({
      list: async () => ({ ok: true, data: { keys: records.map((r) => r.key), truncated: false } }),
      get: async (key: string, { signal }: { signal: AbortSignal }) => {
        signal.addEventListener("abort", () => { state.aborted++; });
        const record = records.find((r) => r.key === key)!;
        return { ok: true, data: { data: { aad: record.aad, key } } };
      },
    }),
    encryption: {
      decryptEnvelope: async (envelope: { key: string }) => {
        state.started++;
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        const { promise, resolve } = Promise.withResolvers<void>();
        pending.push(resolve);
        await promise;
        state.inFlight--;
        const record = records.find((r) => r.key === envelope.key)!;
        return { ok: true, data: new TextEncoder().encode(JSON.stringify(record.batch)) };
      },
    },
  } as unknown as TinyCloudWeb;
  /** Lets every decrypt sent so far finish, then lets the reader run until it waits again. */
  const releaseAll = async () => {
    for (const resolve of pending.splice(0)) resolve();
    // One event-loop turn (no wall-clock wait): the reader's digest and continuations run before the next check.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { tcw, state, releaseAll };
}

describe("readBotHistory", () => {
  test(`decrypts up to ${HISTORY_READ_CONCURRENCY} records at once and returns the whole thread in order`, async () => {
    const thread = await storedThread(10);
    const read = readBotHistory(thread.tcw);
    let settled = false;
    void read.finally(() => { settled = true; });
    while (!settled) await thread.releaseAll();
    const messages = await read;
    expect(thread.state.peak).toBe(HISTORY_READ_CONCURRENCY);
    expect(thread.state.started).toBe(10);
    expect(messages.map((m) => m.text)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
    expect(messages[1]).toEqual({ id: "history-1-1", role: "bot", text: "m1", at: "2026-11-14T00:00:01Z" });
  });

  test("a record that fails its binding check fails the read, and nothing further is decrypted", async () => {
    const thread = await storedThread(10, { corrupt: 0 });
    const read = readBotHistory(thread.tcw);
    const failed = read.then(() => null, (error: unknown) => error);
    let outcome: unknown;
    while ((outcome = await Promise.race([failed, Promise.resolve("pending")])) === "pending") await thread.releaseAll();
    expect(outcome).toEqual(new Error("history_binding_mismatch"));
    // The first round of 4 was in flight when record 0 failed; no further record was started.
    expect(thread.state.started).toBe(HISTORY_READ_CONCURRENCY);
    expect(thread.state.aborted).toBeGreaterThan(0);
  });
});
