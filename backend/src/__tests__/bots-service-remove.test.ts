import { describe, expect, test } from "bun:test";
import { botOwnerDid, botsFromEnv, botsServiceHeaders, removeBotFromService, type BotsConfig } from "../routes/bots.js";

const ADDRESS = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const KEY = "a".repeat(32);
const BOT = `http://bots.test/v1/bots/${KEY}`;

interface Call { method: string; url: string; headers: Record<string, string>; body: string | undefined }

/** A recording stand-in for the bots service. Nothing is sent anywhere. */
function service(answer: (call: Call) => Response | Promise<Response>) {
  const seen: Call[] = [];
  const fetchImpl = (async (input, init) => {
    const call = { method: init?.method ?? "GET", url: String(input), headers: Object.fromEntries(new Headers(init?.headers)), body: typeof init?.body === "string" ? init.body : undefined };
    seen.push(call);
    return answer(call);
  }) as typeof fetch;
  const config: BotsConfig = { ...botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: "bots-test-secret-not-real" })!, fetchImpl };
  return { seen, config };
}
/** Takes the announcement, and answers the removal with `removal`. */
const after = (removal: () => Response | Promise<Response>) => (call: Call) => (call.method === "PUT" ? Response.json({ state: "deleting" }) : removal());

describe("asking the bots service to remove a bot", () => {
  test("it is told the bot is being deleted, under the record's counter, then asked to remove it, and its answer is passed on", async () => {
    for (const outcome of ["gone", "waiting", "failed"] as const) {
      const { seen, config } = service(after(() => Response.json({ outcome, cause: "archive_pending" })));
      expect(await removeBotFromService(config, ADDRESS, KEY, 9)).toBe(outcome);
      const announced = JSON.stringify({ state: "deleting", seq: 9 });
      expect(seen).toEqual([
        { method: "PUT", url: BOT, headers: Object.fromEntries(new Headers(botsServiceHeaders(config, botOwnerDid(ADDRESS), "PUT", BOT, announced))), body: announced },
        { method: "DELETE", url: BOT, headers: Object.fromEntries(new Headers(botsServiceHeaders(config, botOwnerDid(ADDRESS), "DELETE", BOT))), body: undefined },
      ]);
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
