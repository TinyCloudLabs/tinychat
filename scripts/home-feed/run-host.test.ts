import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HooksService, ServiceContext } from "@tinycloud/sdk-services";
import { normalizeHomeMirrorHost } from "./run";

const SPACE = "tinycloud:pkh:eip155:1:0x7777777777777777777777777777777777777777:applications";
const DATABASE = "xyz.tinycloud.tinychat/feed/feed_responses_host_fixture";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

test("the executable host boundary removes trailing root separators", () => {
  for (const input of ["http://node.test", "http://node.test/", "http://node.test///"]) {
    expect(normalizeHomeMirrorHost(input)).toBe("http://node.test");
  }
  expect(normalizeHomeMirrorHost("https://node.test/")).toBe("https://node.test");
});

test("base paths survive normalization without collapsing internal or decoding encoded separators", () => {
  for (const [input, expected] of [
    ["https://node.test/tinycloud/api", "https://node.test/tinycloud/api"],
    ["https://node.test/tinycloud/api/", "https://node.test/tinycloud/api"],
    ["https://node.test/parent//child///", "https://node.test/parent//child"],
    ["https://node.test/parent%2Fchild/", "https://node.test/parent%2Fchild"],
    ["https://node.test/parent%2fchild/", "https://node.test/parent%2fchild"],
  ]) expect(normalizeHomeMirrorHost(input)).toBe(expected);
});

test("the existing absolute HTTP URL and credential/query/fragment restrictions remain enforced", () => {
  for (const input of [
    "not an absolute URL", "ftp://node.test/prefix/", "https://user:synthetic-password@node.test/prefix/",
    "https://node.test/prefix/?token=synthetic", "https://node.test/prefix/#synthetic",
  ]) expect(() => normalizeHomeMirrorHost(input)).toThrow();
});

for (const mount of [
  { name: "root without slash", prefix: "", trailing: "" },
  { name: "root with trailing slash", prefix: "", trailing: "/" },
  { name: "base path without slash", prefix: "/tinycloud/api", trailing: "" },
  { name: "base path with trailing slash", prefix: "/tinycloud/api", trailing: "/" },
]) {
  test(`${mount.name} reaches real hook ticket and SSE endpoints with one boundary separator`, async () => {
    const ticket = randomUUID(), eventId = randomUUID();
    const requests: Array<{ method: string; path: string }> = [];
    let ticketIssued = false;
    const ticketBody = z.object({ subscriptions: z.array(z.object({ space: z.literal(SPACE), service: z.literal("sql"), pathPrefix: z.literal(DATABASE), abilities: z.array(z.string()).optional() })).length(1), ttlSeconds: z.number().optional() });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      // Do not normalize incoming paths or redirect a doubled slash: these are
      // real mount boundaries the executable's configured SDK host must preserve.
      if (request.method === "POST" && url.pathname === `${mount.prefix}/hooks/tickets`) {
        if (request.headers.get("authorization") !== "synthetic-host-fixture") return new Response(null, { status: 401 });
        const parsed = ticketBody.safeParse(await request.json());
        if (!parsed.success) return new Response(null, { status: 400 });
        ticketIssued = true; return Response.json({ ticket });
      }
      if (request.method === "GET" && url.pathname === `${mount.prefix}/hooks/events`) {
        if (!ticketIssued || url.searchParams.get("ticket") !== ticket) return new Response(null, { status: 401 });
        const write = { type: "write", id: eventId, space: SPACE, service: "sql", databasePath: DATABASE,
          path: `db/p${Buffer.from(DATABASE).toString("hex")}/table/${Buffer.from("feed_responses").toString("hex")}`,
          ability: "tinycloud.sql/write", actor: "did:key:synthetic-host-owner", epoch: "synthetic-epoch", eventIndex: 1, timestamp: "2026-10-29T12:00:00.000Z" };
        return new Response(`event: ready\ndata: {"type":"ready"}\n\nevent: write\ndata: ${JSON.stringify(write)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(null, { status: 404 });
    } });
    cleanup.push(() => server.stop(true));
    const host = normalizeHomeMirrorHost(`${server.url.origin}${mount.prefix}${mount.trailing}`);
    const context = new ServiceContext({ hosts: [host], retryPolicy: { maxAttempts: 1 },
      invoke: () => ({ Authorization: "synthetic-host-fixture" }),
      session: { delegationHeader: { Authorization: "synthetic-host-fixture" }, delegationCid: "synthetic-cid", spaceId: SPACE, verificationMethod: "did:key:synthetic-host-owner", jwk: {} },
    });
    const hooks = new HooksService(); hooks.initialize(context);
    const abort = new AbortController();
    cleanup.push(() => { abort.abort(); hooks.onSignOut(); });
    const lifecycle: string[] = [];
    const iterator = hooks.subscribe([{ space: SPACE, service: "sql", pathPrefix: DATABASE }], { signal: abort.signal, onReady: () => { lifecycle.push("ready"); } })[Symbol.asyncIterator]();
    const received = await iterator.next();
    expect(received.done).toBe(false);
    expect(received.value).toMatchObject({ type: "write", id: eventId, space: SPACE, service: "sql", databasePath: DATABASE });
    expect(lifecycle).toEqual(["ready"]);
    expect(requests).toEqual([
      { method: "POST", path: `${mount.prefix}/hooks/tickets` },
      { method: "GET", path: `${mount.prefix}/hooks/events` },
    ]);
    await iterator.return?.();
  });
}
