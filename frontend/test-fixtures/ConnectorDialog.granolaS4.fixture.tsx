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
const { ensureSchema, getConnection, transcriptKvKey } = await import("@/lib/connectors/connectorStore");
const { ConnectorConnectDialog } = await import("@/chat/ConnectorDialog");
const { CONNECTORS } = await import("@/lib/connectors/registry");

const backendUrl = "https://tinychat-backend.example";
const sessionStore = { getToken: () => "fixture-session", isExpired: () => false } as unknown as SessionStore;
const key = "grn_fixture_0123456789";
const replacementKey = "grn_replacement_0123456789";
const listPath = "/api/connectors/granola/v1/notes";
const notePath = `${listPath}/not_fixture`;
const privateNote = "PRIVATE_FIXTURE_DO_NOT_STORE";
const attachment = "https://attachments.example/private-image.png";
const note = {
  id: "not_fixture", title: "Fixture meeting", created_at: "2026-11-10T12:00:00Z",
  updated_at: "2026-11-10T12:01:00Z", summary_text: "A fixture summary",
  private_notes_text: privateNote, attachments: [{ url: attachment }],
};
const ok = <T,>(data: T) => ({ ok: true as const, data });

function fixture() {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  const vault = new Map<string, string>();
  const requests: { url: string; key: string | null; auth: string | null }[] = [];
  let mode: "ok" | "expired" | "inactive" | "summaries" | "session-expired" | "provider-invalid-token" = "ok";
  let pauseDetail: Promise<void> | undefined;
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
    secrets: {
      isUnlocked: true,
      put: async (name: string, value: string) => { vault.set(name, value); return ok(undefined); },
      get: async (name: string) => vault.has(name)
        ? ok(vault.get(name))
        : { ok: false, error: { code: "KEY_NOT_FOUND", message: `Key not found: ${name}` } },
      delete: async (name: string) => { vault.delete(name); return ok(undefined); },
    },
  } as unknown as TinyCloudWeb;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === backendUrl && url.pathname === "/api/connectors/google/autojoin/status") {
      return Response.json({ state: "off", enabled: false, offReason: "never_enabled", lastScanAt: null, errorCode: null, outcomes: [] });
    }
    const headers = new Headers(init?.headers);
    requests.push({ url: url.href, key: headers.get("x-granola-key"), auth: headers.get("authorization") });
    if (url.origin !== backendUrl || !url.pathname.startsWith(listPath)) throw new Error("Unexpected fixture endpoint");
    if (mode === "expired") return Response.json({ code: "INVALID_API_KEY", message: privateNote }, { status: 401 });
    if (mode === "inactive") return Response.json({ code: "SUBSCRIPTION_INACTIVE", message: privateNote }, { status: 403 });
    if (mode === "session-expired") return Response.json({ error: "invalid_token" }, {
      status: 401, headers: { "X-TinyCloud-Session-Rejected": "1" },
    });
    if (mode === "provider-invalid-token") return Response.json({ error: "invalid_token", message: privateNote }, { status: 401 });
    if (url.pathname === listPath) return Response.json({ notes: [note], hasMore: false });
    if (url.pathname === notePath) { await pauseDetail; return Response.json(note); }
    if (url.pathname === `${notePath}/transcript`) {
      if (mode === "summaries") return Response.json({ code: "FORBIDDEN" }, { status: 403 });
      return Response.json({ transcript: [{ speaker: { name: "Ada" }, text: "A fixture transcript", start_time: note.created_at }] });
    }
    throw new Error("Unexpected fixture path");
  }) as typeof globalThis.fetch;
  return { db, kv, vault, tcw, requests, fetch, setMode: (m: typeof mode) => { mode = m; }, holdDetail: (p: Promise<void>) => { pauseDetail = p; } };
}

function button(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find(el => el.textContent?.trim() === label);
}
const row = () => document.querySelector('[data-source="granola"]')!;
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(el => el.querySelector("#granola-api-key") || el.textContent?.includes("Connect Granola"));

async function until(condition: () => unknown, description: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
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

async function enterKey(value: string) {
  const openKey = button(dialog()!, "Connect with an API key");
  if (openKey) await click(dialog()!, "Connect with an API key");
  const input = dialog()?.querySelector("input");
  if (!input) throw new Error("Missing Granola key field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(dialog()!, "Continue");
}

async function mounted(run: (f: ReturnType<typeof fixture> & { remount: () => Promise<void> }) => Promise<void>) {
  const f = fixture();
  const restoreFetch = globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let revision = 0;
  const remount = async () => {
    revision++;
    await act(async () => root.render(<MemoryRouter key={revision}><MeetingSourcesDialog open onOpenChange={() => {}}
      tcw={f.tcw} backendUrl={backendUrl} sessionStore={sessionStore} /></MemoryRouter>));
  };
  try {
    globalThis.fetch = f.fetch;
    expect((await ensureSchema(f.tcw)).ok).toBe(true);
    await remount();
    await until(() => row() && button(row(), "Connect"), "Flag-on Granola Connect should be available");
    await run({ ...f, remount });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = restoreFetch;
    host.remove();
    f.db.close();
  }
}

async function connect(f: ReturnType<typeof fixture>) {
  await click(row(), "Connect");
  await enterKey(key);
  await until(() => button(dialog() ?? document, "Done"), "Initial sync should reach Done");
  await click(dialog()!, "Done");
  expect(f.vault.get("GRANOLA_API_KEY")).toBe(key);
  await until(() => button(row(), "Sync now"), "Saved row should be connected");
}

test("Connect sends the masked key only through TinyCloud and saves summary and transcript", async () => mounted(async f => {
  await click(row(), "Connect");
  expect(row().textContent).toContain("Not connected");
  await click(dialog()!, "Connect with an API key");
  expect(dialog()?.textContent).toContain("Your API key is kept in TinyCloud's encrypted secrets. Each sync sends it through the TinyCloud One server to Granola, and that server never stores or logs it.");
  expect(dialog()?.textContent).toContain("API keys need a Granola Business or Enterprise plan.");
  expect(dialog()?.querySelector("input")?.type).toBe("password");
  const detail = Promise.withResolvers<void>();
  f.holdDetail(detail.promise);
  try {
    await enterKey(key);
    await until(() => dialog()?.querySelector('[role="progressbar"]'), "Initial sync should show meeting progress");
    expect(button(dialog()!, "Stop sync")).toBeDefined();
  } finally { detail.resolve(); }
  await until(() => button(dialog() ?? document, "Done"), "Initial sync should finish");
  await click(dialog()!, "Done");
  expect(f.requests.map(({ url }) => new URL(url).pathname)).toEqual([listPath, listPath, notePath, `${notePath}/transcript`]);
  expect(f.requests.every(request => request.url.startsWith(`${backendUrl}/`) && request.key === key && request.auth === "Bearer fixture-session")).toBe(true);
  expect(f.vault.get("GRANOLA_API_KEY")).toBe(key);
  const stored = f.db.query("SELECT summary_overview, metadata FROM connector_meeting WHERE source = 'granola'").get();
  expect(stored).toMatchObject({ summary_overview: "A fixture summary" });
  expect(JSON.stringify(stored)).not.toContain(privateNote);
  expect(JSON.stringify(stored)).not.toContain(attachment);
  expect(JSON.stringify(f.kv.get(transcriptKvKey("granola", "not_fixture")))).toContain("A fixture transcript");
}));

for (const [mode, message] of [
  ["expired", "Granola didn’t accept this key. Check that it’s an active API key, then try again."],
  ["inactive", "Your Granola plan isn’t active. Granola’s API needs a Business or Enterprise plan. Check your subscription in the Granola app, then try again."],
  ["session-expired", "You're signed out of TinyCloud One. Sign in, then try again."],
] as const) {
  test(`${mode} key stays at key entry with its own error and no credential write`, async () => mounted(async f => {
    f.setMode(mode);
    await click(row(), "Connect");
    await enterKey(key);
    await until(() => dialog()?.querySelector('[role="alert"]'), "Expected an inline key-entry error");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(dialog()?.querySelector("input")?.value).toBe(key);
    expect(f.vault.size).toBe(0);
    expect(await getConnection(f.tcw, "granola")).toEqual({ ok: true, data: null });
  }));
}

test("expired saved key keeps the connection and Reconnect clears just the old key", async () => mounted(async f => {
  await connect(f);
  f.setMode("expired");
  await click(row(), "Sync now");
  await until(() => row().textContent?.includes("Granola didn’t accept the saved key."), "Expected the saved-key warning");
  expect(row().textContent).toContain("Last sync didn't finish. Sync again.");
  expect(row().textContent).toContain("1 meeting");
  expect(button(row(), "Sync now")).toBeDefined();
  await click(row(), "Manage");
  await click(row(), "Reconnect Granola");
  await until(() => dialog()?.querySelector("input"), "Reconnect should open an empty key field");
  expect(dialog()?.querySelector("input")?.value).toBe("");
  expect(f.vault.has("GRANOLA_API_KEY")).toBe(false);
  f.setMode("ok");
  await enterKey(replacementKey);
  await until(() => button(dialog() ?? document, "Done"), "Replacement key should finish sync");
  await click(dialog()!, "Done");
  await until(() => !row().textContent?.includes("Last sync didn't finish. Sync again."), "Reconnect should clear the warning");
  expect(f.vault.get("GRANOLA_API_KEY")).toBe(replacementKey);
  expect(row().textContent).toContain("1 meeting");
}));

test("an upstream 401 with a session-shaped body still offers Granola Reconnect", async () => mounted(async f => {
  await connect(f);
  f.setMode("provider-invalid-token");
  await click(row(), "Sync now");
  await until(() => row().querySelector('[role="alert"]'), "Expected an expired-key warning");
  expect(row().querySelector('[role="alert"]')?.textContent).toContain("Granola didn’t accept the saved key.");
  await f.remount();
  await until(() => row()?.querySelector('[role="alert"]'), "Expected the saved-key warning after reopening");
  expect(row().querySelector('[role="alert"]')?.textContent).toContain("Granola didn’t accept the saved key.");
  await click(row(), "Manage");
  expect(button(row(), "Reconnect Granola")).toBeDefined();
}));

test("Sync now after cancelling Reconnect prompts for a new key without contacting Granola", async () => mounted(async f => {
  await connect(f);
  f.setMode("expired");
  await click(row(), "Sync now");
  await until(() => row().textContent?.includes("Granola didn’t accept the saved key."), "Expected the saved-key warning");
  await click(row(), "Manage");
  await click(row(), "Reconnect Granola");
  await until(() => dialog()?.querySelector("input"), "Reconnect should open the key dialog");
  await click(dialog()!, "Cancel");
  const requestCount = f.requests.length;
  await click(row(), "Sync now");
  await until(() => button(row(), "Sync now") && !button(row(), "Sync now")?.disabled, "Sync now should settle");
  expect(row().querySelector('[role="alert"]')?.textContent).toContain("Reconnect Granola to sync again.");
  expect(button(row(), "Reconnect Granola")).toBeDefined();
  expect(row().textContent).toContain("1 meeting");
  expect(f.requests).toHaveLength(requestCount);
}));

test("admin-disabled transcripts sync summaries and keep the neutral notice on a no-change sync", async () => mounted(async f => {
  f.setMode("summaries");
  await connect(f);
  await until(() => row().textContent?.includes("Summaries only."), "Expected neutral summary-only notice");
  expect(row().textContent).not.toContain("Last sync didn't finish. Sync again.");
  expect(f.db.query("SELECT summary_overview FROM connector_meeting WHERE source = 'granola'").get()).toEqual({ summary_overview: "A fixture summary" });
  expect(JSON.stringify([...f.kv.values()])).not.toContain("A fixture transcript");
  await click(row(), "Sync now");
  await until(() => button(row(), "Sync now") && !button(row(), "Sync now")?.disabled, "No-change sync should settle");
  expect(row().textContent).toContain("Summaries only.");
}));

test("the owner space stores both raw transcript pages with reconstructible timestamps and no private payloads", async () => mounted(async f => {
  const cursor = "dHVybnM+/w==";
  const requests: { path: string; search: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== `${notePath}/transcript`) return f.fetch(input, init);
    requests.push({ path: url.pathname, search: url.search });
    const next = url.searchParams.get("cursor") === cursor;
    return Response.json({
      transcript: [next ? {
        speaker: { source: "speaker", diarization_label: "Speaker B" }, text: "  Verbatim second turn. ",
        start_time: "2026-11-10T12:07:36.250Z", end_time: "2026-11-10T12:07:38.750Z",
        attachments: [{ url: attachment }],
      } : {
        speaker: { source: "microphone", name: "Ada" }, text: "Verbatim first turn.",
        start_time: "2026-11-10T12:07:34.125Z", end_time: "2026-11-10T12:07:36.000Z",
        private_notes_markdown: privateNote,
      }],
      hasMore: !next, cursor: next ? null : cursor,
    });
  }) as typeof fetch;
  await connect(f);

  expect(requests).toEqual([
    { path: `${notePath}/transcript`, search: "?page_size=100" },
    { path: `${notePath}/transcript`, search: `?${new URLSearchParams({ page_size: "100", cursor })}` },
  ]);
  const transcript = f.kv.get(transcriptKvKey("granola", "not_fixture"));
  const persisted = f.db.query("SELECT * FROM connector_meeting WHERE source = 'granola'").get() as { metadata: string };
  expect(JSON.parse(persisted.metadata).granola_transcript_started_at).toBe("2026-11-10T12:07:34.125Z");
  expect(JSON.parse(String(transcript))).toEqual([
    { index: 0, speaker_name: "Ada", text: "Verbatim first turn.", start_time: 0, end_time: 1.875 },
    { index: 1, speaker_name: "Speaker B", text: "  Verbatim second turn. ", start_time: 2.125, end_time: 4.625 },
  ]);
  const written = JSON.stringify([persisted, ...f.kv.values()]);
  expect(written).not.toContain(privateNote);
  expect(written).not.toContain(attachment);
}));

test("admin denial on a later page discards in-flight turns and still syncs the summary", async () => mounted(async f => {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== `${notePath}/transcript`) return f.fetch(input, init);
    if (url.searchParams.has("cursor")) return Response.json({ code: "FORBIDDEN" }, { status: 403 });
    return Response.json({
      transcript: [{ speaker: { name: "Ada" }, text: "Must not be imported after denial" }],
      hasMore: true, cursor: "next",
    });
  }) as typeof fetch;
  await connect(f);
  expect(row().textContent).toContain("Summaries only.");
  expect(await getConnection(f.tcw, "granola")).toMatchObject({ ok: true, data: { lastSyncStatus: "ok" } });
  expect(f.db.query("SELECT summary_overview FROM connector_meeting WHERE source = 'granola'").get())
    .toEqual({ summary_overview: "A fixture summary" });
  expect(JSON.parse(String(f.kv.get(transcriptKvKey("granola", "not_fixture"))))).toEqual([]);
}));

test("non-allowlisted IDs cannot accept credentials even while Granola is enabled", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const f = fixture();
  const restoreFetch = globalThis.fetch;
  const descriptor = { ...CONNECTORS.find(d => d.id === "granola")!, id: "unknown-fixture" as "granola" };
  try {
    globalThis.fetch = f.fetch;
    await act(async () => root.render(<ConnectorConnectDialog tcw={f.tcw} descriptor={descriptor} backendUrl={backendUrl}
      sessionStore={sessionStore} open onOpenChange={() => {}} onConnected={() => {}} />));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("not available yet");
    expect(Boolean(document.querySelector('[role="dialog"] input'))).toBe(false);
    expect(f.requests).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = restoreFetch;
    host.remove();
    f.db.close();
  }
});
