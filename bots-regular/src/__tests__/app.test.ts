import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSink } from "../../../bots/src/bot";
import { OwnerManifests } from "../../../bots/src/manifest";
import { type BotApi, createApp } from "../../../bots/src/server";
import { type Call, signedCallHeader } from "../../../bots/src/signed-call";
import { regularApp } from "../app";

const PRIVATE_SECRET = "p".repeat(64);
const REGULAR_SECRET = "r".repeat(64);
const A = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const B = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
const KEY = "cd".repeat(16);
const tmp = mkdtempSync(join(tmpdir(), "bots-regular-app-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A service whose bots record what reached them. */
function service(make: typeof regularApp) {
  const reached: string[] = [];
  const bot = (owner: string, key: string): BotApi => ({
    send: async (_text: string, sink: TurnSink) => { reached.push(`${owner.slice(-2)} ${key} send`); sink.done("b-1"); },
    list: async () => { reached.push(`${owner.slice(-2)} ${key} list`); return []; },
  });
  const manifest = new OwnerManifests(join(mkdtempSync(join(tmp, "service-")), "owners"));
  manifest.announce(A, KEY, "active", 1);
  const app = make({
    secret: make === regularApp ? REGULAR_SECRET : PRIVATE_SECRET,
    accounts: new Set([A.slice(-42), B.slice(-42)]),
    manifest,
    bots: { forOwner: owner => bot(owner, "main"), forBot: (owner, key) => bot(owner, key) },
  });
  return { app, reached };
}

const privateApp: typeof regularApp = options => createApp({ ...options, environment: "private", acceptLegacyOwnerHeader: false });

function call(secret: string, over: Partial<Call> = {}, path = "/v1/bots/main/messages"): Request {
  const signed: Call = { direction: "to-service", environment: "regular", owner: A, bot: "main", method: "GET", path, ...over };
  return new Request(`http://bots.internal${path}`, { headers: { authorization: signedCallHeader(secret, signed) } });
}

describe("regular service calls", () => {
  test("take a call signed for the regular environment with the regular secret", async () => {
    const { app, reached } = service(regularApp);
    expect((await app(call(REGULAR_SECRET))).status).toBe(200);
    expect((await app(call(REGULAR_SECRET, { owner: B }))).status).toBe(200);
    expect((await app(call(REGULAR_SECRET, { bot: KEY }, `/v1/bots/${KEY}/messages`))).status).toBe(200);
    expect(reached).toEqual(["aa main list", "bb main list", `aa ${KEY} list`]);
  });

  test("refuse a call signed for the private runtime, with its secret, for another bot, or with the old header", async () => {
    const { app, reached } = service(regularApp);
    process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER = "1";
    try {
      const refused = [
        call(REGULAR_SECRET, { environment: "private" }),
        call(PRIVATE_SECRET),
        call(PRIVATE_SECRET, { environment: "private" }),
        call(REGULAR_SECRET, { bot: KEY }),
        call(REGULAR_SECRET, { bot: "main" }, `/v1/bots/${KEY}/messages`),
        call(REGULAR_SECRET, { direction: "to-backend" }),
        new Request("http://bots.internal/v1/bots/main/messages", { headers: { authorization: `Bearer ${REGULAR_SECRET}`, "x-tinycloud-owner": A } }),
      ];
      for (const req of refused) expect((await app(req)).status).toBe(401);
    } finally {
      delete process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER;
    }
    expect(reached).toEqual([]);
  });

  test("a call the regular service can make opens nothing on a private service", async () => {
    const { app, reached } = service(privateApp);
    for (const environment of ["regular", "private"] as const) {
      expect((await app(call(REGULAR_SECRET, { environment }))).status).toBe(401);
    }
    expect((await app(call(PRIVATE_SECRET, { environment: "private" }))).status).toBe(200);
    expect(reached).toEqual(["aa main list"]);
  });
});
