import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { readBotHistory } from "./historyRead";

const ADDRESS = "0x00000000000000000000000000000000000a11ce";
const OWNER = `did:pkh:eip155:1:${ADDRESS}`;
const SPACE = makePkhSpaceId(ADDRESS, 1, "applications");

interface StoredRecord { type: string; text: string; at: string; origin?: string; decision?: string; outcome?: { messageId: string } }

/** A thread whose stored records are exactly `records`, in order. */
async function threadOf(records: StoredRecord[]): Promise<TinyCloudWeb> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(OWNER));
  const prefix = `xyz.tinycloud.tinychat/threads/bots/v1/${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}/`;
  const stored = records.map((record, seq) => {
    const key = `${prefix}1/${seq}-c${seq}`;
    return { key, aad: btoa(JSON.stringify({ owner: OWNER, spaceId: SPACE, path: key })), batch: { v: 1, generation: "1", seq, challenge: `c${seq}`, record } };
  });
  return {
    session: () => ({ address: ADDRESS, chainId: 1 }),
    kvForSpace: () => ({
      list: async () => ({ ok: true, data: { keys: stored.map((entry) => entry.key), truncated: false } }),
      get: async (key: string) => ({ ok: true, data: { data: { aad: stored.find((entry) => entry.key === key)!.aad, key } } }),
    }),
    encryption: {
      decryptEnvelope: async (envelope: { key: string }) => ({ ok: true, data: new TextEncoder().encode(JSON.stringify(stored.find((entry) => entry.key === envelope.key)!.batch)) }),
    },
  } as unknown as TinyCloudWeb;
}

const at = (second: number) => `2026-11-14T00:00:${String(second).padStart(2, "0")}Z`;

describe("readBotHistory and messages the app sent for the owner", () => {
  test("a reply to a question keeps its origin and decision, as the service's own listing gives them", async () => {
    const messages = await readBotHistory(await threadOf([
      { type: "user", text: "The person answered your question: Oslo", at: at(1), origin: "app", decision: "answered" },
      { type: "assistant", text: "Thanks", at: at(2), outcome: { messageId: "m-2" } },
      { type: "user", text: "The person chose not to answer now. Carry on without it, and don’t ask again unless they bring it up.", at: at(3), origin: "app", decision: "declined" },
    ]));
    expect(messages).toEqual([
      { id: "history-1-0", role: "user", text: "The person answered your question: Oslo", at: at(1), origin: "app", decision: "answered" },
      { id: "m-2", role: "bot", text: "Thanks", at: at(2) },
      { id: "history-1-2", role: "user", text: "The person chose not to answer now. Carry on without it, and don’t ask again unless they bring it up.", at: at(3), origin: "app", decision: "declined" },
    ]);
  });

  test("a message sent when the owner turned questions off keeps its decision", async () => {
    const text = "The person turned off questions from you, so your open questions were closed without an answer. Carry on without asking.";
    const messages = await readBotHistory(await threadOf([{ type: "user", text, at: at(1), origin: "app", decision: "stopped" }]));
    expect(messages).toEqual([{ id: "history-1-0", role: "user", text, at: at(1), origin: "app", decision: "stopped" }]);
  });

  test("an ordinary message is unmarked, and an origin that is not the app's or a decision that is not one is dropped", async () => {
    const messages = await readBotHistory(await threadOf([
      { type: "user", text: "typed by the owner", at: at(1) },
      { type: "user", text: "claims another origin", at: at(2), origin: "owner", decision: "answered" },
      { type: "user", text: "an app message with an invented decision", at: at(3), origin: "app", decision: "granted" },
      { type: "assistant", text: "a reply claiming to be the app's", at: at(4), origin: "app", decision: "answered" },
    ]));
    expect(messages).toEqual([
      { id: "history-1-0", role: "user", text: "typed by the owner", at: at(1) },
      { id: "history-1-1", role: "user", text: "claims another origin", at: at(2) },
      { id: "history-1-2", role: "user", text: "an app message with an invented decision", at: at(3), origin: "app" },
      { id: "history-1-3", role: "bot", text: "a reply claiming to be the app's", at: at(4) },
    ]);
  });
});
