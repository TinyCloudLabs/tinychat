import { expect, test } from "bun:test";

import { createBotRosterApi } from "./botRosterApi";
import { BOT_COLOUR_IDS, BOT_SHAPES } from "./botShapes";

const main = {
  key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private",
  state: "active", createdAt: "2026-11-18T23:00:00.000Z",
};
const roster = {
  bots: [main], deleted: [], limits: { private: { max: 3, used: 1 }, regular: { max: 3, used: 0 } },
  canCreate: { private: true, regular: false }, capMode: "flat3",
};

function fakeApi(responses: Response[]) {
  const calls: { path: string; method?: string; authorization: string | null; body?: BodyInit | null }[] = [];
  const api = createBotRosterApi({
    baseUrl: "https://test-backend.invalid/",
    getToken: () => "test-token",
    fetch: async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, method: init?.method, authorization: new Headers(init?.headers).get("authorization"), body: init?.body });
      return responses.shift()!;
    },
  });
  return { api, calls };
}

test("the avatar catalog matches the S2 wire values in order", () => {
  expect(BOT_SHAPES.join(",")).toBe("pebble,sprout,drop,clover,bloom,cloud,ghost,bean,comet,petal,squish,moon,star");
  expect(BOT_COLOUR_IDS.join(",")).toBe("blue,teal,green,lime,yellow,orange,red,pink,purple,indigo,slate");
});

test("the roster decodes live and deleted bots and keeps server-provided over-limit values", async () => {
  const deleting = {
    ...main, key: "ab".repeat(16), name: "Research", shape: "star", colour: "teal",
    state: "deleting", deletingSince: "2026-11-19T00:00:00.000Z",
  };
  const response = {
    bots: [main, deleting], deleted: [{ key: "cd".repeat(16), name: "Archive" }],
    limits: { ...roster.limits, private: { max: 0, used: 1 } }, canCreate: { private: false, regular: false }, capMode: "table",
  };
  const { api, calls } = fakeApi([Response.json(response)]);
  expect(await api.list()).toEqual(response);
  expect(calls).toEqual([{ path: "/api/bots", method: "GET", authorization: "Bearer test-token", body: undefined }]);
});

test("the roster rejects missing or malformed wire fields", async () => {
  for (const malformed of [
    { ...roster, deleted: undefined },
    { ...roster, canCreate: "true" },
    { ...roster, capMode: "unknown" },
    { ...roster, limits: null },
    { ...roster, limits: { ...roster.limits, private: { max: 3, used: -1 } } },
    { ...roster, bots: [{ ...main, shape: "unknown" }] },
    { ...roster, bots: [{ ...main, createdAt: "Wednesday" }] },
    { ...roster, bots: [main, { ...main, key: "ab".repeat(16), state: "deleting" }] },
    { ...roster, bots: [main, { ...main, key: "AB".repeat(16) }] },
    { ...roster, deleted: [{ key: "main", name: "Main" }] },
  ]) {
    await expect(fakeApi([Response.json(malformed)]).api.list()).rejects.toMatchObject({ code: "invalid_response" });
  }
});

test("a table roster still lists bots while the account plan is unavailable", async () => {
  const response = { ...roster, limits: null, capMode: "table", canCreate: { private: false, regular: false } };
  expect(await fakeApi([Response.json(response)]).api.list()).toEqual(response);
});

test("create and restyle send only editable fields and report conflicts", async () => {
  const bot = { ...main, key: "ab".repeat(16), name: "Research", shape: "sprout", colour: "teal" };
  const { api, calls } = fakeApi([
    Response.json({ bot }, { status: 201 }),
    Response.json({ bot: { ...main, colour: "teal" } }),
    Response.json({ error: "bot_limit", environment: "private" }, { status: 409 }),
    Response.json({ bot: { ...bot, state: "deleting", deletingSince: "2026-11-19T00:00:00.000Z" } }, { status: 202 }),
  ]);
  const input = { name: " Research ", shape: "sprout", colour: "teal" } as const;
  expect(await api.create(input)).toEqual(bot);
  expect(await api.update("main", { colour: "teal" })).toMatchObject({ colour: "teal" });
  await expect(api.create(input)).rejects.toMatchObject({ code: "bot_limit", environment: "private" });
  expect(await api.remove(bot.key)).toMatchObject({ key: bot.key, state: "deleting" });
  await expect(api.remove("../main")).rejects.toMatchObject({ code: "not_found" });
  expect(calls.map(({ path, method, body }) => [path, method, body])).toEqual([
    ["/api/bots", "POST", '{"name":"Research","shape":"sprout","colour":"teal"}'],
    ["/api/bots/main", "PATCH", '{"colour":"teal"}'],
    ["/api/bots", "POST", '{"name":"Research","shape":"sprout","colour":"teal"}'],
    [`/api/bots/${bot.key}`, "DELETE", undefined],
  ]);
});
