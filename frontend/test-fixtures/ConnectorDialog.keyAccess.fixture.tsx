// TC-3804: the connect dialogs ask OpenKey for the connector's own key before saving it, and Meet waits for a click.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const backend = "https://synthetic-backend.invalid";
let connects = 0;
const realClient = await import("@tinyboilerplate/client");
// OpenKey's window is the one boundary faked here: it answers as the signed-in owner.
mock.module("@tinyboilerplate/client", () => ({
  ...realClient,
  connectWallet: async () => {
    connects++;
    return { address: OWNER, openkey: { signMessage: async () => ({ signature: "synthetic" }) } };
  },
}));

const restoreImportDom = installDom();
const { createRoot } = await import("react-dom/client");
const { ConnectorConnectDialog } = await import("@/chat/ConnectorDialog");
const { CONNECTORS } = await import("@/lib/connectors/registry");
const store = await import("@/lib/connectors/connectorStore");
const { isConnectorKeyAccessPaused, markConnectorKeyAccessPaused, resetConnectorKeyAccessForTests } =
  await import("@/lib/connectors/connectorKeyAccess");
const { ConnectorKeyAccessPaused } = await import("@/chat/ConnectorKeyAccessPaused");

const fireflies = CONNECTORS.find((d) => d.id === "fireflies")!;
const meet = { ...CONNECTORS.find((d) => d.id === "google-meet")!, status: "available" as const };
const realFetch = globalThis.fetch;
const ok = <T,>(data: T) => ({ ok: true as const, data });

let restoreDom: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let db: Database;
let approve = false;
let held = false;
let asks: number[] = [];
let puts: string[] = [];
let popupUrl = "";

function fakeTcw() {
  const kv = new Map<string, unknown>();
  const vault = new Map<string, string>();
  return {
    did: `did:example:${crypto.randomUUID()}`,
    session: () => ({
      address: OWNER,
      chainId: 1,
      sessionKey: "synthetic-session-key",
      siwe: `Expiration Time: ${new Date(Date.now() + 30 * 86_400_000).toISOString()}`,
    }),
    hasPermissions: () => held,
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (_permissions: unknown, options: { expiryMs: number }) => {
      asks.push(options.expiryMs);
      held = approve;
      return { approved: approve };
    },
    sql: { db: () => ({
      query: async (sql: string, params: SQLQueryBindings[] = []) => ok({ rows: db.query(sql).values(...params) }),
      execute: async (sql: string, params: SQLQueryBindings[] = []) => {
        const result = db.query(sql).run(...params);
        return ok({ changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) });
      },
    }) },
    kv: {
      get: async (key: string) => kv.has(key)
        ? ok({ data: kv.get(key), headers: {} })
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
      put: async (key: string, value: unknown) => { kv.set(key, value); return ok({ data: undefined, headers: {} }); },
      delete: async (key: string) => { kv.delete(key); return ok(undefined); },
      list: async () => ok({ keys: [], truncated: false }),
    },
    secrets: {
      isUnlocked: true,
      put: async (name: string, value: string) => { puts.push(name); vault.set(name, value); return ok(undefined); },
      get: async (name: string) => vault.has(name)
        ? ok(vault.get(name))
        : { ok: false, error: { code: "KEY_NOT_FOUND", message: `Key not found: ${name}` } },
      delete: async (name: string) => { vault.delete(name); return ok(undefined); },
    },
  } as unknown as TinyCloudWeb;
}

const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === "https://api.fireflies.ai/graphql" && String(init?.body).includes("GetUser")) {
    return Response.json({ data: { user: { name: "Ada", email: "ada@example.invalid" } } });
  }
  if (url.origin === backend && url.pathname === "/api/connectors/google/oauth/exchange") {
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
  }
  return new Response("synthetic outage", { status: 503 });
}) as typeof fetch;
const tick = () => Bun.sleep(0);
async function settle() {
  await act(async () => { await tick(); await tick(); });
}
function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}
async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 80 && !predicate(); attempt++) await settle();
  expect(predicate(), `${message}; DOM=${dialog()?.textContent}`).toBe(true);
}
function button(label: string) {
  return [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
}
async function click(label: string) {
  await until(() => !!button(label) && !button(label)!.disabled, `expected ${label}`);
  await act(async () => { button(label)!.click(); await tick(); });
  await settle();
}

async function mount(descriptor: typeof fireflies) {
  const tcw = fakeTcw();
  expect((await store.ensureSchema(tcw)).ok).toBe(true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<ConnectorConnectDialog tcw={tcw} descriptor={descriptor} backendUrl={backend}
    sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore}
    open onOpenChange={() => {}} onConnected={() => {}} />));
  await settle();
}

beforeEach(() => {
  restoreDom = installDom();
  db = new Database(":memory:");
  approve = false;
  held = false;
  asks = [];
  puts = [];
  connects = 0;
  popupUrl = "";
  resetConnectorKeyAccessForTests();
  globalThis.fetch = fetchFake;
  window.fetch = fetchFake;
  Object.defineProperty(window, "open", { configurable: true, value: () => {
    const popup = { closed: false, close() { this.closed = true; }, location: {} };
    Object.defineProperty(popup.location, "href", { set(value: string) { popupUrl = value; } });
    return popup;
  } });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = realFetch;
  store._resetConnectorSchemaMemoForTests();
  restoreDom?.();
  db.close();
});
afterAll(() => restoreImportDom());

const NOT_CONNECTED = (name: string) => `${name} isn't connected. TinyChat needs your approval in OpenKey to use it. Nothing was saved.`;

test("Fireflies: a declined approval saves nothing; the same button asks again and saves once approved", async () => {
  await mount(fireflies);
  const input = dialog().querySelector<HTMLInputElement>("#fireflies-api-key")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ff-synthetic-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Continue");
  await click("Save & sync");
  await until(() => dialog().textContent!.includes(NOT_CONNECTED("Fireflies")), "expected T1b");
  expect(asks).toHaveLength(1);
  expect(asks[0]).toBeLessThanOrEqual(7 * 86_400_000);
  expect(puts).toEqual([]);

  approve = true;
  await click("Save & sync");
  await until(() => puts.length === 1, "expected the key saved after approval");
  expect(asks).toHaveLength(2);
  expect(connects).toBe(2);
});

test("Google Meet: waits on Approve in OpenKey, asks only on that click, and saves nothing when declined", async () => {
  await mount(meet);
  await click("Continue with Google");
  await until(() => popupUrl.length > 0, "expected Google's window");
  const state = new URL(popupUrl).searchParams.get("state");
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { origin: backend, data: { code: "synthetic-code", state } }));
    await tick();
  });
  await until(() => !!button("Approve in OpenKey"), "expected the approval step");
  expect(dialog().textContent).toContain(
    "Lets TinyChat use your Google Meet connection to bring in your meetings. Only this connection, for up to 7 days.",
  );
  expect({ asks: asks.length, connects, puts }).toEqual({ asks: 0, connects: 0, puts: [] });

  await click("Approve in OpenKey");
  await until(() => dialog().textContent!.includes(NOT_CONNECTED("Google Meet")), "expected T1b");
  expect({ asks: asks.length, puts }).toEqual({ asks: 1, puts: [] });

  approve = true;
  await click("Approve in OpenKey");
  await until(() => puts.length === 1, "expected the refresh token saved after approval");
  expect(asks).toHaveLength(2);
});

test("a paused row shows T1c and asks only when Approve in OpenKey is pressed", async () => {
  const tcw = fakeTcw();
  let synced = 0;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<ConnectorKeyAccessPaused tcw={tcw} descriptor={fireflies} onApproved={() => synced++} />));
  expect(host.textContent).toBe("");

  await act(async () => markConnectorKeyAccessPaused(tcw, "fireflies"));
  expect(host.textContent).toContain("Paused. Approve TinyChat's access to keep your Fireflies meetings coming in.");
  expect({ asks: asks.length, connects }).toEqual({ asks: 0, connects: 0 });

  approve = true;
  const press = [...host.querySelectorAll("button")].find((b) => b.textContent === "Approve in OpenKey")!;
  await act(async () => { press.click(); await tick(); });
  await settle();
  expect({ asks: asks.length, synced }).toEqual({ asks: 1, synced: 1 });
  expect(isConnectorKeyAccessPaused(OWNER, "fireflies")).toBe(false);
  expect(host.textContent).toBe("");
});
