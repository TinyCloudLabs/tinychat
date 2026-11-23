import { expect, test } from "bun:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import express from "express";
import { createApiBodyParser } from "../body-parsing.js";
import { createBotsServiceGuardRouter } from "../bots-service-routes.js";
import { signedCallHeader } from "../bots-signed-call.js";
import { createTrustBotReadsInternalRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads.js";
import type { BotsConfig } from "../routes/bots.js";
import { createReadAudit, purgeReadAudit, type ReadAuditAttempt } from "../trustbot-reads/audit.js";
import { ReadGrantRefused, type TrustBotReadGrants } from "../trustbot-reads/grants.js";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const other = `did:pkh:eip155:1:0x${"cd".repeat(20)}`;
const secret = "t".repeat(64);
const tool = "tinycloud_find_meetings";
const at = "2026-11-23T12:00:00.000Z";
const before = "2026-11-23T00:00:00.000Z";
const after = "2026-11-24T00:00:00.000Z";
const attempt: ReadAuditAttempt = { owner, area: "meetings", tool, at };

function storage() {
  const values = new Map<string, { data: string; headers: { etag: string } }>();
  const events: string[] = [];
  let reject: "all" | "settlement" | undefined;
  let revision = 0;
  const missing = (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } });
  const get = (key: string) => values.has(key) ? { ok: true, data: values.get(key) } : missing(key);
  const node = {
    kv: {
      async get(key: string) { return get(key); },
      async put(key: string, data: string, condition: { ifMatch?: string; ifNoneMatch?: string }) {
        if (reject === "all" || (reject === "settlement" && condition.ifMatch) ||
          (condition.ifNoneMatch && values.has(key)) ||
          (condition.ifMatch && values.get(key)?.headers.etag !== condition.ifMatch)) {
          return { ok: false, error: { code: "KV_WRITE_FAILED", message: "private error text" } };
        }
        values.set(key, { data, headers: { etag: `"${++revision}"` } });
        events.push((JSON.parse(data) as { outcome: string }).outcome);
        return { ok: true };
      },
      async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
        const matching = [...values.keys()].sort().filter(key => key.startsWith(prefix) && (!cursor || key > cursor));
        const keys = matching.slice(0, 2);
        const truncated = matching.length > keys.length;
        return { ok: true, data: { keys, truncated, nextCursor: truncated ? keys.at(-1) : undefined } };
      },
      async batchGet(keys: string[]) {
        return { ok: true, data: { results: keys.map(key => ({ key, result: get(key) })) } };
      },
      async delete(key: string) { values.delete(key); return { ok: true }; },
    },
  } as unknown as TinyCloudNode;
  return {
    node, values, events,
    rejectWrites: (mode: typeof reject = "all") => { reject = mode; },
  };
}

test("private audit rows are unique, contain only fixed metadata and keep pending attempts visible", async () => {
  const { node, values } = storage();
  const audit = createReadAudit(node, () => Date.parse(at));
  const [first, second] = await Promise.all([
    audit.begin({ ...attempt, secret: "unused" } as ReadAuditAttempt),
    audit.begin(attempt),
  ]);
  expect(first).not.toBe(second);
  expect(first).toStartWith(`trustbot/read-audit/${owner}/2026-11-23/`);
  expect(JSON.parse(values.get(first)!.data)).toEqual({ area: "meetings", tool, outcome: "pending" });
  await audit.settle(first, "ok");
  await audit.settle(first, "ok");
  await expect(audit.settle(first, "error")).rejects.toThrow();
  await expect(audit.begin({ ...attempt, tool: "private_token" })).rejects.toThrow();
  await expect(audit.begin({ ...attempt, owner: owner.toUpperCase() })).rejects.toThrow();
  await expect(audit.begin({ ...attempt, area: "feed_chats" })).rejects.toThrow();
  expect(await audit.summary(owner, before, after)).toEqual({
    owner, from: before, to: after, total: 2,
    days: [{ day: "2026-11-23", area: "meetings", tool, ok: 1, refused: 1 }],
  });
});

test("summary paginates, isolates owners and enforces range and retention", async () => {
  const { node, values } = storage();
  const now = Date.parse(at);
  const audit = createReadAudit(node, () => now);
  const expired = new Date(now - 90 * 86_400_000 - 1).toISOString();
  const old = await Promise.all([
    audit.begin({ ...attempt, at: expired }),
    audit.begin({ ...attempt, at: expired }),
    audit.begin({ ...attempt, at: expired, owner: other }),
  ]);
  await audit.settle(await audit.begin({ ...attempt, at: before }), "budget");
  await audit.settle(await audit.begin({ ...attempt, at: "2026-11-22T12:00:00.000Z" }), "off");
  await audit.settle(await audit.begin({ ...attempt, area: "feed_chats", tool: "read_card" }), "not_found");
  await audit.begin({ ...attempt, at: after });
  await audit.begin({ ...attempt, owner: other });
  const unrelated = "trustbot/read-grants/owner";
  values.set(unrelated, { data: "unrelated", headers: { etag: '"unrelated"' } });
  expect(await audit.summary(owner, expired, after)).toEqual({
    owner, from: expired, to: after, total: 3,
    days: [
      { day: "2026-11-22", area: "meetings", tool, ok: 0, refused: 1 },
      { day: "2026-11-23", area: "feed_chats", tool: "read_card", ok: 0, refused: 1 },
      { day: "2026-11-23", area: "meetings", tool, ok: 0, refused: 1 },
    ],
  });
  await purgeReadAudit(node, now);
  expect(old.every(key => !values.has(key))).toBe(true);
  expect(values.size).toBe(6);
  expect(values.has(unrelated)).toBe(true);
});

async function withRoute(run: (fixture: ReturnType<typeof storage> & {
  post(path: string, body: unknown, signature?: { owner?: string; secret?: string }): Promise<Response>;
}) => Promise<void>, refusal?: ConstructorParameters<typeof ReadGrantRefused>[0], auditEnabled = true) {
  const fixture = storage();
  const grants = {
    async access() {
      fixture.events.push("access");
      if (refusal) throw new ReadGrantRefused(refusal);
      return {
        sql: { db: () => ({ query: async () => { fixture.events.push("query"); return { ok: true, data: { rows: [] } }; } }) },
      };
    },
  } as unknown as TrustBotReadGrants;
  const config = { accountAllowed: (address: string) => owner.endsWith(address) } as BotsConfig;
  const app = express();
  app.use(createBotsServiceGuardRouter());
  app.use(createApiBodyParser());
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({
    grants, config, callSecret: secret, audit: auditEnabled ? createReadAudit(fixture.node) : undefined,
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    await run({
      ...fixture,
      post(name, input, signature = {}) {
        const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${name}`;
        const body = JSON.stringify(input);
        const authorization = signedCallHeader(signature.secret ?? secret, {
          direction: "to-backend", environment: "private", owner: signature.owner ?? owner, bot: "main", method: "POST", path, body,
        });
        return fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
      },
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("the signed HTTP read commits before accessing the grant and settles after the query", async () => {
  await withRoute(async ({ post, events }) => {
    const response = await post(tool, { args: { limit: 3 } });
    expect(await response.json()).toMatchObject({ ok: true });
    expect(events).toEqual(["pending", "access", "access", "query", "query", "ok"]);
  });
});

test("the signed HTTP read refuses a failed audit commit without accessing the grant", async () => {
  await withRoute(async ({ post, events, rejectWrites }) => {
    rejectWrites();
    const response = await post(tool, { args: { limit: 3 } });
    expect(await response.json()).toEqual({ ok: false, error: "unavailable" });
    expect(events).toEqual([]);
  });
});

test("a failed settlement leaves the durable attempt and withholds the tool result", async () => {
  await withRoute(async ({ post, events, rejectWrites, values }) => {
    rejectWrites("settlement");
    expect(await (await post(tool, { args: { limit: 3 } })).json()).toEqual({ ok: false, error: "unavailable" });
    expect(events).toEqual(["pending", "access", "access", "query", "query"]);
    expect([...values.values()].map(entry => JSON.parse(entry.data).outcome)).toEqual(["pending"]);
  });
});

test("a refused grant is recorded even when the tool never runs", async () => {
  await withRoute(async ({ post, events }) => {
    expect(await (await post(tool, { args: {} })).json()).toEqual({ ok: false, error: "off" });
    expect(events).toEqual(["pending", "access", "no_grant"]);
  }, "none");
});

test("the internal audit endpoint validates the signed owner and accepts only fixed refusal metadata", async () => {
  await withRoute(async ({ post, events }) => {
    const report = { owner, area: "meetings", tool, outcome: "off" };
    expect((await post("audit/refusal", report, { secret: "wrong" })).status).toBe(401);
    expect((await post("audit/refusal", { ...report, owner: other })).status).toBe(400);
    expect((await post("audit/refusal", { ...report, area: "feed_chats" })).status).toBe(400);
    expect((await post("audit/refusal", { ...report, tool: "private_token" })).status).toBe(400);
    expect((await post("audit/refusal", { ...report, args: { query: "private_text" } })).status).toBe(400);
    expect((await post("audit/refusal", { ...report, outcome: "ok" })).status).toBe(400);
    for (const outcome of ["off", "budget", "busy"]) {
      expect((await post("audit/refusal", { ...report, outcome })).status).toBe(204);
    }
    expect((await post("audit/refusal", { ...report, owner: other }, { owner: other })).status).toBe(404);
    expect(events).toEqual(["pending", "off", "pending", "budget", "pending", "busy", "pending", "not_owner"]);
  });
});

test("with standing reads off the finite read path requires no audit writes", async () => {
  await withRoute(async ({ post, events, rejectWrites }) => {
    rejectWrites();
    const report = { owner, area: "meetings", tool, outcome: "off" };
    expect((await post("audit/refusal", report)).status).toBe(204);
    expect(await (await post(tool, { args: { limit: 3 } })).json()).toMatchObject({ ok: true });
    expect(events).toEqual(["access", "access", "query", "query"]);
  }, undefined, false);
});

test("gateway refusal reports share one daily budget per authenticated Main owner", async () => {
  await withRoute(async ({ post, events }) => {
    const report = { owner, area: "meetings", tool, outcome: "off" };
    for (let count = 0; count < 200; count++) {
      expect((await post("audit/refusal", { ...report, outcome: count % 2 ? "budget" : "off" })).status).toBe(204);
    }
    expect((await post("audit/refusal", { ...report, outcome: "busy" })).status).toBe(429);
    expect(events).toHaveLength(400);
    expect((await post("audit/refusal", { ...report, owner: other }, { owner: other })).status).toBe(404);
    expect(events.slice(-2)).toEqual(["pending", "not_owner"]);
    expect(await (await post(tool, { args: { limit: 3 } })).json()).toMatchObject({ ok: true });
  });
}, 15_000);
