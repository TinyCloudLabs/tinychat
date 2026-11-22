// A signed history call names its bot (TC-3813): one signed for bot A is refused at bot B's URL, for every history
// operation the backend calls, whether the signed path or only the signed bot is A's.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerManifests } from "../manifest";
import { type BotApi, createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const SECRET = "s".repeat(64);
const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);
const ORIGIN = "http://bots.internal";
const tmp = mkdtempSync(join(tmpdir(), "history-bot-binding-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Every history operation the backend calls, as `[method, path after /v1/bots/<key>, body]`. */
const OPERATIONS: Array<[string, string, string | undefined]> = [
  ["GET", "/history", undefined],
  ["POST", "/history", '{"body":{},"signature":"0x"}'],
  ["POST", "/history/stage", '{"seq":1}'],
  ["PUT", "/history/permission", '{"validUntil":1}'],
  ["GET", "/history/notice", undefined],
  ["POST", "/history/notice", '{"id":"n1","receivedAt":1}'],
];

function service() {
  const reached: string[] = [];
  const bot = (key: string): BotApi => ({
    send: async () => { reached.push(`${key} send`); },
    list: async () => [],
    historyPending: async () => { reached.push(`${key} pending`); return null; },
    historyReceipt: async () => { reached.push(`${key} receipt`); },
    historyStage: async () => { reached.push(`${key} stage`); },
    historyPermission: async () => { reached.push(`${key} permission`); },
    historyNotice: async () => { reached.push(`${key} notice`); return null; },
    historyNoticeAck: async () => { reached.push(`${key} ack`); },
  });
  const manifest = new OwnerManifests(join(mkdtempSync(join(tmp, "service-")), "owners"));
  manifest.announce(OWNER, KEY_A, "active", 1);
  manifest.announce(OWNER, KEY_B, "active", 2);
  const app = createApp({ secret: SECRET, accounts: new Set([OWNER.slice(-42)]), environment: "private", acceptLegacyOwnerHeader: false, manifest, bots: { forOwner: () => bot("main"), forBot: (_owner, key) => bot(key) } });
  return { app, reached };
}

/** Signed as the backend signs a call to `/v1/bots/<signedKey><rest>`, with the bot claim `bot`, then sent to `/v1/bots/<sentKey><rest>`. */
function call(method: string, rest: string, body: string | undefined, signed: { key: string; bot: string }, sentKey: string) {
  const authorization = signedCallHeader(SECRET, { direction: "to-service", environment: "private", owner: OWNER, bot: signed.bot, method, path: `/v1/bots/${signed.key}${rest}`, body });
  return new Request(`${ORIGIN}/v1/bots/${sentKey}${rest}`, { method, headers: { authorization }, body });
}

describe("a history call signed for one bot", () => {
  test("is refused at another bot's URL, and reaches neither bot", async () => {
    const { app, reached } = service();
    for (const [method, rest, body] of OPERATIONS) {
      // A's whole call replayed to B's URL.
      expect([method, rest, (await app(call(method, rest, body, { key: KEY_A, bot: KEY_A }, KEY_B))).status]).toEqual([method, rest, 401]);
      // B's path signed, but with A as the bot.
      expect([method, rest, (await app(call(method, rest, body, { key: KEY_B, bot: KEY_A }, KEY_B))).status]).toEqual([method, rest, 401]);
      // Main's call replayed to a bot's URL.
      expect([method, rest, (await app(call(method, rest, body, { key: "main", bot: "main" }, KEY_B))).status]).toEqual([method, rest, 401]);
    }
    expect(reached).toEqual([]);
  });

  test("is accepted at its own bot's URL", async () => {
    const { app, reached } = service();
    for (const [method, rest, body] of OPERATIONS) {
      const status = (await app(call(method, rest, body, { key: KEY_A, bot: KEY_A }, KEY_A))).status;
      expect([method, rest, status >= 200 && status < 300]).toEqual([method, rest, true]);
    }
    expect(reached).toEqual([`${KEY_A} pending`, `${KEY_A} receipt`, `${KEY_A} stage`, `${KEY_A} permission`, `${KEY_A} notice`, `${KEY_A} ack`, `${KEY_A} notice`]);
  });
});
