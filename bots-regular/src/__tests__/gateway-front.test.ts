import { describe, expect, test } from "bun:test";
import { controlFetch, sandboxFetch } from "../gateway-front";
import { sandboxIdFor } from "../provider";

const A = "a".repeat(64);
const B = "b".repeat(64);
const TOKEN = "1".repeat(64);

function recordingGateway() {
  const calls: { botId: string; path: string }[] = [];
  const tokens = new Map<string, { token: string; owner?: string }>();
  return {
    calls,
    tokens,
    handle: async (botId: string, req: Request) => {
      calls.push({ botId, path: `${new URL(req.url).pathname}${new URL(req.url).search}` });
      return new Response(null, { status: 204 });
    },
    setToken: (botId: string, token: string, owner?: string) => void tokens.set(botId, { token, owner }),
    dropToken: (botId: string) => void tokens.delete(botId),
  };
}

describe("gateway front", () => {
  test("a sandbox's request reaches the gateway as the bot its path names, with the prefix removed", async () => {
    const gateway = recordingGateway();
    const fetch = sandboxFetch(gateway);
    expect((await fetch(new Request(`http://gw/bots/${A}/v1/chat/completions?x=1`, { method: "POST", body: "{}" }))).status).toBe(204);
    expect(gateway.calls).toEqual([{ botId: A, path: "/v1/chat/completions?x=1" }]);
    for (const path of [`/v1/models`, `/bots/${A}`, `/bots/${A}/v2/models`, `/bots/${A.toUpperCase()}/v1/models`, `/bots/${A}x/v1/models`]) {
      expect((await fetch(new Request(`http://gw${path}`))).status).toBe(404);
    }
    expect(gateway.calls).toHaveLength(1);
  });

  test("the control socket sets and drops one bot's token and refuses anything malformed", async () => {
    const gateway = recordingGateway();
    const control = controlFetch(gateway, botId => [botId]);
    const put = (path: string, body: unknown) => control(new Request(`http://c${path}`, { method: "PUT", body: JSON.stringify(body) }));
    expect((await put(`/bots/${A}`, { token: TOKEN, owner: B })).status).toBe(204);
    expect(gateway.tokens.get(A)).toEqual({ token: TOKEN, owner: B });
    expect((await put(`/bots/${A}`, { token: "short" })).status).toBe(400);
    expect((await put(`/bots/${A}`, { token: TOKEN, owner: "did:pkh:x" })).status).toBe(400);
    expect((await put(`/bots/xyz`, { token: TOKEN })).status).toBe(404);
    expect(await (await control(new Request(`http://c/bots/${B}/receipts`))).json()).toEqual([B]);
    expect((await control(new Request(`http://c/bots/${A}`, { method: "DELETE" }))).status).toBe(204);
    expect(gateway.tokens.has(A)).toBe(false);
  });
});

describe("sandbox ids", () => {
  test("are built from the hashed bot id alone and never from anything else", () => {
    expect(sandboxIdFor(A)).toBe(`bot-${"a".repeat(52)}`);
    expect(sandboxIdFor(A)).toHaveLength(56);
    expect(sandboxIdFor(B)).not.toBe(sandboxIdFor(A));
    for (const bad of ["", "a".repeat(63), A.toUpperCase(), `${"a".repeat(60)}/../`, `did:pkh:eip155:1:0x${"a".repeat(40)}`]) {
      expect(() => sandboxIdFor(bad)).toThrow("invalid bot id");
    }
  });
});
