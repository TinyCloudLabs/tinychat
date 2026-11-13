// The Home feed's page-close outbox in real Chromium. The page runs the real Home feed and store
// (frontend/src/harness/homeFeedOutboxHarness.ts); this test serves it and plays the node: SQL over HTTP on SQLite,
// with a write that can be held back. A tab is closed during the 5 s undo, or right after it while
// the write is still in flight, then Home is opened again in the same browser profile.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  feedResourceNames, initializeFeedDatabases, listFeedResponses, publishFeedCard,
  type FeedCard, type FeedDatabase, type FeedResponse,
} from "@tinycloud/sdk-services/feed";
import type { OutboxPageApi } from "../frontend/src/harness/homeFeedOutboxHarness";

setDefaultTimeout(60_000);

declare global { interface Window { harness: OutboxPageApi } }

const HOME_FEED_RESOURCE = "xyz.tinycloud.tinychat/home_feed";
type Params = (string | number | null)[];
type Statement = { sql: string; params?: Params };

/** One SQLite database per space and resource, as the node keeps them. */
const databases = new Map<string, Database>();
function database(space: string, resource: string) {
  const key = `${space}|${resource}`;
  let found = databases.get(key);
  if (!found) { found = new Database(":memory:"); databases.set(key, found); }
  return found;
}
function run(db: Database, op: string, sql: string, params: Params) {
  const statement = db.query(sql);
  if (op === "query") {
    const rows = statement.values(...params);
    return { columns: statement.columnNames, rows, rowCount: rows.length };
  }
  const result = statement.run(...params);
  return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
}
function handle(space: string, resource: string): FeedDatabase {
  const db = database(space, resource);
  return {
    query: async (sql: string, params: Params = []) => ({ ok: true, data: run(db, "query", sql, params) }),
    execute: async (sql: string, params: Params = []) => ({ ok: true, data: run(db, "execute", sql, params) }),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try { const results = statements.map((item) => run(db, "execute", item.sql, item.params ?? [])); db.exec("COMMIT"); return { ok: true, data: { results } }; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as FeedDatabase;
}

/** Writes to a responses database wait this long first (a slow node), and are dropped if the page is gone by then. */
let writeDelayMs = 0;
/** Settles when a held-back write reaches the node, and when it has then landed or been dropped. */
let writeArrived = Promise.withResolvers<void>();
let heldBackWrite = Promise.withResolvers<"landed" | "dropped">();
/** Every response write that reached SQLite, in order. */
const landed: { space: string; at: number }[] = [];

let server: ReturnType<typeof Bun.serve>;
let chrome: Browser;
let bundle: string;

beforeAll(async () => {
  const frontend = new URL("../frontend/", import.meta.url).pathname;
  const built = await Bun.build({
    entrypoints: [`${frontend}src/harness/homeFeedOutboxHarness.ts`],
    root: frontend,
    target: "browser",
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname !== "/sql") return new Response('<!doctype html><meta charset="utf-8"><title>Home</title><script type="module" src="/bundle.js"></script>', { headers: { "content-type": "text/html" } });
      const body = await request.json() as { space: string; resource: string; op: string; sql?: string; params?: Params; statements?: Statement[] };
      const db = database(body.space, body.resource);
      try {
        if (body.op !== "batch") return Response.json({ ok: true, data: run(db, body.op, body.sql!, body.params ?? []) });
        if (body.resource.includes("/feed_responses_") && writeDelayMs > 0) {
          writeArrived.resolve();
          await Bun.sleep(writeDelayMs);
          // The tab closed while this write was on its way: it never reached the node.
          if (request.signal.aborted) { heldBackWrite.resolve("dropped"); return new Response(null, { status: 499 }); }
          heldBackWrite.resolve("landed");
        }
        db.exec("BEGIN");
        try {
          const results = body.statements!.map((item) => run(db, "execute", item.sql, item.params ?? []));
          db.exec("COMMIT");
          if (body.resource.includes("/feed_responses_")) landed.push({ space: body.space, at: Date.now() });
          return Response.json({ ok: true, data: { results } });
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } catch (error) {
        return Response.json({ ok: false, error: { code: "SQL_ERROR", message: String(error) } });
      }
    },
  });
  chrome = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await Promise.race([chrome?.close(), Bun.sleep(10_000)]);
  server?.stop(true);
  for (const db of databases.values()) db.close();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message);
  return result.data as T;
}

const CARD: FeedCard = { cardId: "flight", revision: 1, issuanceId: "flight-1", kind: "ask", needsResponse: true, title: "Book the Thursday flight?", body: "The 09:10 has two seats left.", urgency: 2, createdAt: new Date().toISOString(),
  choices: [{ id: "go", label: "Go" }, { id: "hold", label: "Hold" }] };

/** A space with one connected agent and its card, seeded as the agent would publish it. */
async function seed(space: string) {
  const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "browseragent"));
  const output = handle(space, names.outputResource);
  const responses = handle(space, names.responseResource);
  value(await initializeFeedDatabases({ output, responses }));
  value(await publishFeedCard(output, CARD));
  // The page's own Home store creates the registry schema; the agent row goes in once it exists.
  return { output, responses, register() {
    database(space, HOME_FEED_RESOURCE).query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)")
      .run("browseragent", "did:key:browser-agent", "Travel agent", names.outputResource, names.responseResource, "{}");
  } };
}

/**
 * Polls the page from the test until `check` holds. The page's clock is faked, and Playwright's
 * own waitForFunction polls on that clock's animation frames.
 */
async function until(page: Page, check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await page.evaluate(check)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function open(context: BrowserContext, space: string, mount = true): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
  await page.goto(`${server.url}?space=${encodeURIComponent(space)}`);
  await until(page, () => "harness" in window, "the harness");
  if (mount) await page.evaluate(() => window.harness.mount());
  return page;
}
async function stored(responses: FeedDatabase): Promise<FeedResponse[]> {
  return value(await listFeedResponses(responses));
}
/** A first visit creates the space's registry; the agent registers; then the owner opens Home and sees the card. */
async function firstVisit(context: BrowserContext, space: string, agent: Awaited<ReturnType<typeof seed>>) {
  const setup = await open(context, space);
  // The heading's line shows while loading too; the empty card shows once the store has loaded.
  await setup.locator("#home-empty-title").waitFor();
  // The page reads before it creates: on a new space the registry exists once its first read has failed and the batch has run.
  const registry = database(space, HOME_FEED_RESOURCE);
  for (let attempt = 0; attempt < 200 && !registry.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed_agents'").get(); attempt++) await Bun.sleep(50);
  agent.register();
  await setup.close();
  const page = await open(context, space);
  // Cards are short by default: a tap opens the card in place, with its options.
  await page.getByRole("button", { name: /Book the Thursday flight\?/ }).click();
  await page.getByRole("button", { name: /^Go/ }).waitFor();
  return page;
}

describe("Home's page-close outbox in Chromium", () => {
  for (const when of ["during the 5 s undo", "right after the undo, with the write still in flight"] as const) {
    test(`closing the tab ${when}: reopening Home stores the answer exactly once, with its original responseId`, async () => {
      const space = `outbox-${crypto.randomUUID()}`;
      const agent = await seed(space);
      const context = await chrome.newContext();
      // The page's clock is driven by the test, so the 5 s undo takes no real time.
      await context.clock.install();
      const page = await firstVisit(context, space, agent);

      await page.getByRole("button", { name: /^Go/ }).click();
      let heldBack: "landed" | "dropped" | undefined;
      if (when === "during the 5 s undo") await page.clock.runFor(1500);
      else {
        writeDelayMs = 1500;
        writeArrived = Promise.withResolvers();
        heldBackWrite = Promise.withResolvers();
        // The countdown ends and the write leaves; the node is slow to take it.
        await page.clock.runFor(5000);
        await writeArrived.promise;
        await until(page, () => Object.keys(window.harness.outbox()).length === 1, "the held answer");
      }
      await page.close({ runBeforeUnload: true });
      if (writeDelayMs) { heldBack = await heldBackWrite.promise; writeDelayMs = 0; }
      const landedBeforeReopen = landed.filter((write) => write.space === space).length;

      const reopened = await open(context, space, false);
      const held = await reopened.evaluate(() => window.harness.outbox());
      // The closing tab's own write never reached the node: what follows is the resend path, not the dedupe path.
      expect(landedBeforeReopen).toBe(0);
      if (when !== "during the 5 s undo") expect(heldBack).toBe("dropped");
      console.log(`[${when}] in-flight write: ${heldBack ?? "none"}; writes landed before reopening: ${landedBeforeReopen}; held at reopen: ${JSON.stringify(Object.values(held))}`);
      expect(Object.keys(held)).toHaveLength(1);
      const entry = JSON.parse(Object.values(held)[0]!) as { responseId: string; choiceId: string };
      expect(entry.choiceId).toBe("go");

      await reopened.evaluate(() => window.harness.mount());
      await until(reopened, () => Object.keys(window.harness.outbox()).length === 0, "the outbox to empty");
      // An answered card leaves "Needs action": it is under All, short until tapped open.
      await reopened.getByRole("radio", { name: "All", exact: true }).check();
      await reopened.getByRole("button", { name: /Book the Thursday flight\?/ }).click();
      await reopened.getByText("You chose Go.").waitFor();
      await reopened.getByText("Sent when you opened Home again.").waitFor();
      const rows = await stored(agent.responses);
      console.log(`[${when}] stored after reopening: ${JSON.stringify(rows.map((row) => [row.responseId, row.kind, row.choiceId]))}`);
      expect(rows.map((row) => [row.responseId, row.kind, row.choiceId])).toEqual([[entry.responseId, "answer", "go"]]);
      expect(await reopened.evaluate(() => window.harness.outbox())).toEqual({});
      await context.close();
    });
  }

  test("a card replaced before Home reopens gets no write, and its refusal line shows", async () => {
    const space = `outbox-${crypto.randomUUID()}`;
    const agent = await seed(space);
    const context = await chrome.newContext();
    await context.clock.install();
    const page = await firstVisit(context, space, agent);

    await page.getByRole("button", { name: /^Go/ }).click();
    await page.clock.runFor(1500);
    await page.close({ runBeforeUnload: true });
    value(await publishFeedCard(agent.output, { ...CARD, revision: 2, issuanceId: "flight-2", title: "Book the Friday flight?" }));

    const reopened = await open(context, space, false);
    expect(Object.keys(await reopened.evaluate(() => window.harness.outbox()))).toHaveLength(1);
    await reopened.evaluate(() => window.harness.mount());
    const line = reopened.getByText("This card changed. Answer the newer version.");
    await line.waitFor();
    console.log(`[replaced] refusal line: ${JSON.stringify(await line.textContent())}`);
    expect(await line.textContent()).toBe("Not sent: Go. This card changed. Answer the newer version.");
    await reopened.getByRole("button", { name: "Show the newer version" }).waitFor();
    expect(await stored(agent.responses)).toEqual([]);
    expect(await reopened.evaluate(() => window.harness.outbox())).toEqual({});
    await context.close();
  });
});
