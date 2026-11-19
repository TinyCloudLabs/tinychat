// The Granola CSV import in a real browser: the real Meeting sources window, a real file chosen in the
// browser's file picker, the real connector store over a SQLite space, and the real backend ledger routes
// (served in-process on loopback). No account, no node: the page's SQL goes to the test's SQLite.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";
import {
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  respondToConnectorPurgeCheck,
  type ConnectorControl,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../backend/src/routes/connector-webhooks";

const express = createRequire(new URL("../backend/package.json", import.meta.url))("express") as typeof import("express");

const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const SHOTS = process.env.GRANOLA_CSV_SHOTS;
const CSV = [
  "Title,Created,Attendees,Summary,Transcript",
  'Weekly planning,2026-11-10T14:00:00Z,ada@example.com,"Agreed the roadmap.","Ada: hello"',
  'Design review,2026-11-11T09:30:00Z,bob@example.com,"Reviewed mocks.",',
].join("\n");

class LedgerOnlyControl implements ConnectorControl {
  readonly ledgers = new Map<string, PurgeLedger>();
  async readDisabled() { return null; }
  async markDisabled() {}
  async clearDisabled() {}
  async readLedger(source: string, address: string): Promise<PurgeLedgerRead> {
    const ledger = this.ledgers.get(`${source}/${address}`);
    return ledger === undefined ? { status: "absent" } : { status: "ok", ledger };
  }
  async writeLedger(source: string, address: string, ledger: PurgeLedger) { this.ledgers.set(`${source}/${address}`, ledger); }
  async clearLedger(source: string, address: string) { this.ledgers.delete(`${source}/${address}`); }
  async quarantineLedger() {}
  async clearQuarantinedLedger() {}
}

let browser: Browser;
let server: ReturnType<typeof serveHarness>;
let backend: import("http").Server;
let backendPort: number;
let control: LedgerOnlyControl;
const purgeChecks: { meetingId: string; source: unknown }[] = [];

beforeAll(async () => {
  process.env.VITE_GRANOLA_CONNECTOR_ENABLED = "true";
  server = serveHarness(await buildHarness());
  browser = await chromium.launch({ headless: true });
  control = new LedgerOnlyControl();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const body = req.body as { meetingId?: string; source?: unknown } | undefined;
    if (req.path.endsWith("/purge-check")) purgeChecks.push({ meetingId: body?.meetingId ?? "", source: body?.source });
    (req as unknown as { user: { address: string } }).user = { address: ADDRESS };
    next();
  });
  app.post("/api/connectors/webhooks/purge-check", (req, res) => respondToConnectorPurgeCheck(control, req, res));
  app.use("/api/connectors/webhooks", createConnectorWebhookCompanionRouter({
    tokens: { config: async () => null } as never,
    queue: { clear: async () => ({ cleared: 0, superseded: 0 }) } as never,
    control,
    limiters: new ConnectorWebhookLimiters({ ipLimit: 0, tokenSuccessLimit: 0 }),
  }));
  backend = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  backendPort = (backend.address() as AddressInfo).port;
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  backend?.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([browser?.close(), new Promise((resolve) => { timer = setTimeout(resolve, 10_000); })]);
  } finally { clearTimeout(timer); }
}, 20_000);

async function openDialog(theme: "light" | "dark", db: Database): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.exposeFunction("__granolaCsvSql", (kind: "query" | "execute", sql: string, params: SQLQueryBindings[]) => {
    if (kind === "query") return db.query(sql).values(...params);
    const result = db.query(sql).run(...params);
    return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
  });
  await page.route("**/api/connectors/webhooks/**", async (route) => {
    const request = route.request();
    const upstream = await fetch(`http://127.0.0.1:${backendPort}${new URL(request.url()).pathname}`, {
      method: request.method(),
      headers: { "content-type": "application/json" },
      body: request.method() === "GET" ? undefined : (request.postData() ?? undefined),
    });
    await route.fulfill({ status: upstream.status, contentType: "application/json", body: await upstream.text() });
  });
  const problems: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  page.on("pageerror", (error) => problems.push(String(error)));
  await page.goto(`${server.url}/?screen=granola-csv-interactive&theme=${theme}&platform=web`);
  try {
    await page.locator('[data-granola-csv-harness="ready"]').waitFor({ state: "attached", timeout: 15_000 });
    await page.locator('[data-source="granola"]').waitFor({ timeout: 15_000 });
  } catch (cause) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
    throw new Error(`Granola row never showed. Page errors: ${problems.join(" | ").slice(0, 600)}. Page text: ${text}`, { cause });
  }
  await page.locator('[data-source="granola"]').getByRole("button", { name: "Connect" }).click();
  await page.getByRole("dialog", { name: "Connect Granola" }).waitFor();
  return page;
}

async function chooseFile(page: Page, text: string) {
  const dialog = page.getByRole("dialog", { name: "Connect Granola" });
  if (!(await dialog.getByRole("button", { name: "Upload the CSV" }).isVisible())) {
    await dialog.getByRole("button", { name: "Get started" }).click();
  }
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Upload the CSV" }).click();
  await (await chooser).setFiles({ name: "granola-export.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
}

const titles = (db: Database) => (db.query("SELECT title FROM connector_meeting WHERE source = 'granola' ORDER BY title").values() as string[][]).map((r) => r[0]);

for (const theme of ["light", "dark"] as const) {
  describe(`Granola CSV import at 390 px (${theme})`, () => {
    test("a real upload shows the meetings, and deleted meetings stay out until allowed back", async () => {
      const db = new Database(":memory:");
      control.ledgers.clear();
      purgeChecks.length = 0;
      const page = await openDialog(theme, db);
      try {
        const dialog = page.getByRole("dialog", { name: "Connect Granola" });
        expect(await dialog.getByText("Import a Granola export").isVisible()).toBe(true);
        expect(await dialog.getByText("Basic (free) · One-time import").isVisible()).toBe(true);
        expect(await dialog.locator("#granola-api-key").count()).toBe(0);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/dialog-closed-${theme}.png` });

        await dialog.getByRole("button", { name: "Get started" }).click();
        await dialog.getByText("Click Generate CSV.").waitFor();
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/guide-open-${theme}.png` });

        await chooseFile(page, CSV);
        await dialog.getByText("2 meetings imported.").waitFor();
        expect(titles(db)).toEqual(["Design review", "Weekly planning"]);
        expect(purgeChecks).toHaveLength(2);
        expect(purgeChecks.every((c) => c.source === "granola")).toBe(true);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/imported-${theme}.png` });

        await chooseFile(page, CSV);
        await dialog.getByText("Nothing new to import.").waitFor();
        expect(titles(db)).toHaveLength(2);

        // The owner deletes a meeting: its row goes and Granola's ledger records it (what Disconnect does).
        // The watermark sits between the two meetings, so only the earlier one is deleted.
        const weekly = (db.query("SELECT source_id FROM connector_meeting WHERE title = 'Weekly planning'").values() as string[][])[0]![0]!;
        db.query("DELETE FROM connector_meeting WHERE title = 'Weekly planning'").run();
        const recorded = await fetch(`http://127.0.0.1:${backendPort}/api/connectors/webhooks/purged`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "granola", ids: [weekly], purgedThrough: "2026-11-10T20:00:00.000Z" }),
        });
        expect(recorded.status).toBeLessThan(300);

        await chooseFile(page, CSV);
        await dialog.getByText("1 meeting was skipped because you deleted it.").waitFor();
        expect(titles(db)).toEqual(["Design review"]);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/skipped-deleted-${theme}.png` });

        await dialog.getByRole("button", { name: "Allow deleted meetings back" }).click();
        await dialog.getByRole("button", { name: "Allow them back" }).click();
        await dialog.getByText("Deleted meetings can be imported again.").waitFor();
        expect(control.ledgers.has(`granola/${ADDRESS}`)).toBe(false);

        await chooseFile(page, CSV);
        await dialog.getByText("1 meeting imported.").waitFor();
        expect(titles(db)).toEqual(["Design review", "Weekly planning"]);
      } finally {
        await page.close();
        db.close();
      }
    }, 60_000);

    test("a file that can't be read imports nothing", async () => {
      const db = new Database(":memory:");
      const page = await openDialog(theme, db);
      try {
        const dialog = page.getByRole("dialog", { name: "Connect Granola" });
        await chooseFile(page, 'Title,Summary\n"never closed,Body');
        await dialog.getByRole("alert").waitFor();
        expect(await dialog.getByRole("alert").textContent()).toContain("Upload the CSV from Granola's email.");
        expect(titles(db)).toEqual([]);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/unreadable-${theme}.png` });
      } finally {
        await page.close();
        db.close();
      }
    }, 60_000);
  });
}
