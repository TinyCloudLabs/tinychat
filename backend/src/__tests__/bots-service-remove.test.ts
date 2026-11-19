import { describe, expect, test } from "bun:test";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";
import { botOwnerDid, botsFromEnv, removeBotFromService, type BotsConfig } from "../routes/bots.js";

const ADDRESS = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const KEY = "a".repeat(32);
const BOT = `http://bots.test/v1/bots/${KEY}`;
const SECRET = "bots-test-secret-not-real";

interface Call { method: string; url: string; authorization: string | null; body: string | undefined }

/** A recording stand-in for the bots service. Nothing is sent anywhere. */
function service(answer: (call: Call) => Response | Promise<Response>) {
  const seen: Call[] = [];
  const fetchImpl = (async (input, init) => {
    const call = { method: init?.method ?? "GET", url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : undefined };
    seen.push(call);
    return answer(call);
  }) as typeof fetch;
  const config: BotsConfig = { ...botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: SECRET })!, fetchImpl };
  return { seen, config };
}
/** Takes the announcement, and answers the removal with `removal`. */
const after = (removal: () => Response | Promise<Response>) => (call: Call) => (call.method === "PUT" ? Response.json({ state: "deleting" }) : removal());
/** Who a recorded call was signed for. Undefined unless it verifies for exactly the method, path and body sent. */
const signedFor = (call: Call): { owner: string; bot: string } | undefined => {
  const claims = verifyCall(call.authorization, { method: call.method, path: new URL(call.url).pathname, body: call.body }, { secret: SECRET, direction: "to-service", environment: "private", nonces: new NonceGuard() });
  return claims ? { owner: claims.owner, bot: claims.bot } : undefined;
};

describe("asking the bots service to remove a bot", () => {
  test("it is told the bot is being deleted, under the record's counter, then asked to remove it, and its answer is passed on", async () => {
    for (const outcome of ["gone", "waiting", "failed"] as const) {
      const { seen, config } = service(after(() => Response.json({ outcome, cause: "archive_pending" })));
      expect(await removeBotFromService(config, ADDRESS, KEY, 9)).toBe(outcome);
      expect(seen.map(call => [call.method, call.url, call.body])).toEqual([["PUT", BOT, JSON.stringify({ state: "deleting", seq: 9 })], ["DELETE", BOT, undefined]]);
      // Each call is signed on its own, for this owner and this bot.
      for (const call of seen) expect(signedFor(call)).toEqual({ owner: botOwnerDid(ADDRESS), bot: KEY });
      expect(seen[0]!.authorization).not.toBe(seen[1]!.authorization);
    }
  });

  test("if it cannot be told, it is not asked to remove anything", async () => {
    for (const refusal of [() => new Response("no", { status: 500 }), () => Promise.reject(new Error("down"))]) {
      const { seen, config } = service(refusal);
      expect(await removeBotFromService(config, ADDRESS, KEY, 9)).toBe("failed");
      expect(seen.map(call => call.method)).toEqual(["PUT"]);
    }
  });

  test("a bot the service no longer has is gone", async () => {
    const { config } = service(after(() => new Response("not found", { status: 404 })));
    expect(await removeBotFromService(config, ADDRESS, KEY, 9)).toBe("gone");
  });

  test("anything unclear is a failure, never 'gone'", async () => {
    const unclear: Array<() => Response | Promise<Response>> = [
      () => new Response("no", { status: 500 }),
      () => new Response("no", { status: 409 }),
      () => new Response("nope", { status: 200 }),
      () => Response.json({ outcome: "done" }),
      () => Response.json({}),
      () => Response.json(null),
      () => Promise.reject(new Error("down")),
    ];
    for (const removal of unclear) {
      const { config } = service(after(removal));
      expect(await removeBotFromService(config, ADDRESS, KEY, 9)).toBe("failed");
    }
  });
});
