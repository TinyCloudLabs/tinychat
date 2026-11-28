import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";

// Install the DOM before loading React DOM.
const restoreDom = installDom();
afterAll(restoreDom);
const { createRoot } = await import("react-dom/client");
const { GranolaCsvImport } = await import("@/chat/GranolaCsvImport");
const { ensureSchema } = await import("@/lib/connectors/connectorStore");

const backendUrl = "https://tinychat-backend.example";
const sessionStore = { getToken: () => "fixture-session", isExpired: () => false } as unknown as SessionStore;
const ok = <T,>(data: T) => ({ ok: true as const, data });

const NO_MEETINGS = "There were no meetings in that file.";

// The files a person can upload that do not parse.
const BAD_FILES = {
  "bad-columns.csv": "colour,shape\r\nred,circle\r\n",
  "bad-empty.csv": "",
  "bad-quote.csv": 'Title,Summary\r\n"unterminated summary,x\r\n',
  "bad-ragged.csv": "Title,Summary\r\nA,B,C\r\n",
};

const TWO_MEETINGS = [
  "Title,Created,Attendees,Summary,Transcript",
  'Weekly planning,2026-11-10T14:00:00Z,ada@example.com,"Agreed the roadmap.","Ada: hello"',
  'Design review,2026-11-11T09:30:00Z,bob@example.com,"Reviewed mocks.",',
].join("\n");

function fixture(failPurgeCheckFrom = Infinity) {
  const db = new Database(":memory:");
  const tcw = {
    did: `did:fixture:${crypto.randomUUID()}`,
    sql: { db: () => ({
      query: async (sql: string, params: SQLQueryBindings[] = []) => ok({ rows: db.query(sql).values(...params) }),
      execute: async (sql: string, params: SQLQueryBindings[] = []) => {
        const result = db.query(sql).run(...params);
        return ok({ changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) });
      },
    }) },
    kv: {
      get: async () => ok({ data: undefined, headers: {} }),
      put: async () => ok({ data: undefined, headers: {} }),
    },
  } as unknown as TinyCloudWeb;
  let purgeChecks = 0;
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin !== backendUrl || !url.pathname.endsWith("/purge-check")) throw new Error("Unexpected fixture endpoint");
    purgeChecks++;
    if (purgeChecks >= failPurgeCheckFrom) return new Response(null, { status: 500 });
    return Response.json({ blocked: false });
  }) as typeof globalThis.fetch;
  return { db, tcw, fetch, titles: () => (db.query("SELECT title FROM connector_meeting").values() as string[][]).map(r => r[0]).sort() };
}

// The upload button makes its file picker on demand; catch it to hand it a file.
const pickers: HTMLInputElement[] = [];
const createElement = document.createElement.bind(document);
document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const element = createElement(tag, options);
  if (tag === "input") pickers.push(element as HTMLInputElement);
  return element;
}) as typeof document.createElement;

async function until(condition: () => unknown, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await act(async () => { await Bun.sleep(10); });
  }
  throw new Error(description);
}

async function importFile(text: string, failPurgeCheckFrom?: number) {
  const f = fixture(failPurgeCheckFrom);
  const restoreFetch = globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    globalThis.fetch = f.fetch;
    expect((await ensureSchema(f.tcw)).ok).toBe(true);
    await act(async () => root.render(<GranolaCsvImport tcw={f.tcw} backendUrl={backendUrl} sessionStore={sessionStore} />));
    const buttons = () => [...host.querySelectorAll("button")];
    await act(async () => buttons().find(el => el.textContent?.trim() === "Get started")!.click());
    pickers.length = 0;
    await act(async () => buttons().find(el => el.textContent?.trim() === "Upload the CSV")!.click());
    const input = pickers.find(el => el.type === "file")!;
    const file = new File([text], "granola-export.csv", { type: "text/csv" });
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => host.querySelector('[role="alert"]'), "The import should end in an error");
    // The alert sits in a block with one line per message.
    const lines = [...host.querySelector('[role="alert"]')!.parentElement!.querySelectorAll("p")].map(p => p.textContent ?? "");
    return { lines, text: host.textContent ?? "", titles: f.titles() };
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = restoreFetch;
    host.remove();
    f.db.close();
  }
}

for (const [name, text] of Object.entries(BAD_FILES)) {
  test(`${name} shows the alert alone`, async () => {
    const result = await importFile(text);
    expect(result.lines).toHaveLength(1);
    expect(result.text).not.toContain(NO_MEETINGS);
    expect(result.titles).toEqual([]);
  });
}

test("a failure after some meetings were saved still shows what was imported", async () => {
  const result = await importFile(TWO_MEETINGS, 2);
  expect(result.titles).toHaveLength(1);
  expect(result.lines).toEqual([
    "Couldn't check which meetings you deleted, so the import stopped. Try again.",
    "1 meeting imported.",
  ]);
  expect(result.text).not.toContain(NO_MEETINGS);
});
