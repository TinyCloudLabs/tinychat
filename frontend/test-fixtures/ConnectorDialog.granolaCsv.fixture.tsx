import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";

// Install the DOM before loading React DOM and Radix.
const restoreDom = installDom();
afterAll(restoreDom);
const { createRoot } = await import("react-dom/client");
const { MeetingSourcesDialog } = await import("@/capture/meetingSources/MeetingSourcesDialog");
const { ensureSchema } = await import("@/lib/connectors/connectorStore");

const backendUrl = "https://tinychat-backend.example";
const sessionStore = { getToken: () => "fixture-session", isExpired: () => false } as unknown as SessionStore;
const ok = <T,>(data: T) => ({ ok: true as const, data });

const GOOD = [
  "Title,Created,Attendees,Summary,Transcript",
  'Weekly planning,2026-11-10T14:00:00Z,ada@example.com,"Agreed the roadmap.","Ada: hello"',
  'Design review,2026-11-11T09:30:00Z,bob@example.com,"Reviewed mocks.",',
].join("\n");

function fixture() {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  const purgeChecks: { meetingId: string; source: unknown }[] = [];
  const cleared: unknown[] = [];
  const blocked = new Set<string>();
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
      get: async (path: string) => ok({ data: kv.get(path), headers: {} }),
      put: async (path: string, value: unknown) => { kv.set(path, value); return ok({ data: undefined, headers: {} }); },
    },
  } as unknown as TinyCloudWeb;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== backendUrl) throw new Error("Unexpected fixture endpoint");
    if (url.pathname === "/api/connectors/google/autojoin/status") {
      return Response.json({ state: "off", enabled: false, offReason: "never_enabled", lastScanAt: null, errorCode: null, outcomes: [] });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.endsWith("/purge-check")) {
      purgeChecks.push({ meetingId: body.meetingId, source: body.source });
      return Response.json({ blocked: blocked.has(body.meetingId) });
    }
    if (url.pathname.endsWith("/purged") && init?.method === "DELETE") {
      cleared.push(body.source);
      blocked.clear();
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fixture path ${url.pathname}`);
  }) as typeof globalThis.fetch;
  const titles = () => (db.query("SELECT title FROM connector_meeting WHERE source = 'granola' ORDER BY title").values() as string[][]).map(r => r[0]);
  const ids = () => (db.query("SELECT source_id FROM connector_meeting WHERE source = 'granola'").values() as string[][]).map(r => r[0]);
  return { db, tcw, fetch, purgeChecks, cleared, blocked, titles, ids };
}

const textOf = (root: ParentNode) => root.textContent ?? "";
function button(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find(el => el.textContent?.trim() === label);
}
const row = () => document.querySelector('[data-source="granola"]')!;
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(el => el.textContent?.includes("Connect Granola"))!;

async function until(condition: () => unknown, description: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await act(async () => { await Bun.sleep(10); });
  }
  throw new Error(description);
}

async function click(root: ParentNode, label: string) {
  const target = button(root, label);
  if (!target || target.disabled) throw new Error(`Missing enabled ${label} button`);
  await act(async () => target.click());
}

// The upload button makes its file picker on demand; catch it to hand it a file.
const pickers: HTMLInputElement[] = [];
const createElement = document.createElement.bind(document);
document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const element = createElement(tag, options);
  if (tag === "input") pickers.push(element as HTMLInputElement);
  return element;
}) as typeof document.createElement;

async function upload(text: string, name = "granola-export.csv") {
  if (!button(dialog(), "Upload the CSV")) await click(dialog(), "Get started");
  pickers.length = 0;
  await click(dialog(), "Upload the CSV");
  const input = pickers.find(el => el.type === "file");
  if (!input) throw new Error("The upload button should open a file picker");
  const file = new File([text], name, { type: "text/csv" });
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mounted(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  const restoreFetch = globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    globalThis.fetch = f.fetch;
    expect((await ensureSchema(f.tcw)).ok).toBe(true);
    await act(async () => root.render(<MemoryRouter><MeetingSourcesDialog open onOpenChange={() => {}}
      tcw={f.tcw} backendUrl={backendUrl} sessionStore={sessionStore} /></MemoryRouter>));
    await until(() => row() && button(row(), "Connect"), "Flag-on Granola Connect should be available");
    await click(row(), "Connect");
    await until(() => dialog(), "Connect dialog should open");
    await run(f);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = restoreFetch;
    host.remove();
    f.db.close();
  }
}

test("the guide opens and closes, the API key stays out of the way until asked for", () => mounted(async () => {
  expect(textOf(dialog())).toContain("Import a Granola export");
  expect(button(dialog(), "Upload the CSV")).toBeUndefined();
  expect(dialog().querySelector("#granola-api-key")).toBeNull();
  await click(dialog(), "Get started");
  expect(textOf(dialog())).toContain("Export your notes from Granola");
  expect(dialog().querySelector<HTMLAnchorElement>("a[href^='https://grano.la/']")?.rel).toContain("noreferrer");
  expect(button(dialog(), "Upload the CSV")).toBeDefined();
  await click(dialog(), "Hide steps");
  expect(button(dialog(), "Upload the CSV")).toBeUndefined();
  await click(dialog(), "Connect with an API key");
  expect(dialog().querySelector<HTMLInputElement>("#granola-api-key")?.type).toBe("password");
}));

test("an upload stores the meetings after a purge check for each, and a second upload adds none", () => mounted(async (f) => {
  await upload(GOOD);
  await until(() => textOf(dialog()).includes("2 meetings imported."), "Import should finish");
  expect(f.titles()).toEqual(["Design review", "Weekly planning"]);
  expect(f.purgeChecks).toHaveLength(2);
  expect(f.purgeChecks.every(c => c.source === "granola")).toBe(true);

  await upload(GOOD);
  await until(() => textOf(dialog()).includes("Nothing new to import."), "Re-import should report nothing new");
  expect(f.titles()).toHaveLength(2);
}));

test("a file that can't be read imports nothing and says what to do next", () => mounted(async (f) => {
  await upload('Title,Summary\n"never closed,Body');
  await until(() => dialog().querySelector('[role="alert"]'), "Malformed file should show an error");
  expect(textOf(dialog().querySelector('[role="alert"]')!)).toContain("Upload the CSV from Granola's email.");
  expect(f.titles()).toEqual([]);
  expect(f.purgeChecks).toEqual([]);
}));

test("a deleted meeting is skipped until the owner allows deleted meetings back", () => mounted(async (f) => {
  await upload(GOOD);
  await until(() => f.titles().length === 2, "First import should store both");
  const [weekly] = (f.db.query("SELECT source_id FROM connector_meeting WHERE title = 'Weekly planning'").values() as string[][])[0]!;
  f.db.query("DELETE FROM connector_meeting WHERE title = 'Weekly planning'").run();
  f.blocked.add(weekly!);

  await upload(GOOD);
  await until(() => textOf(dialog()).includes("skipped because you deleted it."), "Deleted meeting should be skipped");
  expect(f.titles()).toEqual(["Design review"]);

  await click(dialog(), "Allow deleted Granola meetings back");
  await click(dialog(), "Allow them back");
  await until(() => f.cleared.includes("granola"), "Allow back should clear Granola's ledger");
  expect(f.cleared).toEqual(["granola"]);

  await upload(GOOD);
  await until(() => f.titles().length === 2, "Meeting should come back");
}));
