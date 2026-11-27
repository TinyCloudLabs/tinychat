import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { CONNECTORS } from "@/lib/connectors/registry";
import * as actualLink from "@/lib/connectors/googleCalendarLink";
import * as actualRunner from "@/lib/calendarLink/linkRunner";

// The dialog is real; the linking library behind it is replaced at its two entry points, so what is
// asserted is what the dialog asks of it and what the dialog itself sends and writes.
type SaveInput = { refreshToken: string; desktop: boolean; scope: string | undefined; grant?: unknown };
type SaveResult = { ok: true } | { ok: false; reason: "locked" | "scope" | "storage"; message?: string };
const saves: SaveInput[] = [];
let saveResult: SaveResult = { ok: true };
let backfills = 0;

mock.module("@/lib/connectors/googleCalendarLink", () => ({
  ...actualLink,
  saveCalendarLinkConnection: async (_tcw: TinyCloudWeb, input: SaveInput) => { saves.push(input); return saveResult; },
}));
mock.module("@/lib/calendarLink/linkRunner", () => ({
  ...actualRunner,
  // Never settles: the dialog must finish without waiting for the notes to be linked.
  calendarLinkRunner: () => ({ backfill: () => { backfills++; return Promise.withResolvers<null>().promise; } }),
}));

const restoreImportDom = installDom();
// Imported here, not statically: React and Radix decide at import time whether a DOM exists, and the
// stand-ins above must be registered before the dialog's module graph loads.
const { ConnectorConnectDialog } = await import("@/chat/ConnectorDialog");

const descriptor = CONNECTORS.find((entry) => entry.id === "google-meet")!;
const backend = "https://synthetic-oauth.invalid";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly openid";
const GRANT = { version: 1, subjectHash: "synthetic-subject", tokenHashes: ["synthetic-token-hash"] };
const realFetch = globalThis.fetch;
const tick = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

let restoreDom: (() => void) | undefined;
let restoreOpen: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let requests: { path: string; method: string; body: unknown }[] = [];
let popupUrl = "";
let secretWrites = 0;
let connectedCalls = 0;
let closed = 0;

const tcw = {
  did: "did:example:calendar-link-dialog",
  spaceId: "calendar-link-dialog",
  secrets: {
    isUnlocked: true,
    unlock: async () => ({ ok: true, data: undefined }),
    put: async () => { secretWrites++; return { ok: true, data: undefined }; },
    get: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Synthetic missing token" } }),
    delete: async () => ({ ok: true, data: undefined }),
  },
} as unknown as TinyCloudWeb;

async function settle() {
  await act(async () => { await tick(); await tick(); });
}
async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40 && !predicate(); attempt++) await settle();
  expect(predicate(), `${message}; DOM=${document.body.innerHTML}`).toBe(true);
}
function dialog() {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(node).toBeTruthy();
  return node!;
}
async function click(label: string) {
  const target = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label);
  expect(target, `missing ${label}; DOM=${dialog().innerHTML}`).toBeTruthy();
  await act(async () => { target!.click(); await tick(); });
  await settle();
}
/** Continue with Google, then the callback page's message for the state this click minted. */
async function authorize() {
  await click("Continue with Google");
  await until(() => popupUrl.length > 0, "expected the popup to be sent to the start URL");
  const start = new URL(popupUrl);
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", {
      origin: backend,
      data: { code: "synthetic-authorization-code", state: start.searchParams.get("state") },
    }));
    await tick();
  });
  await settle();
  return start;
}

beforeEach(async () => {
  restoreDom = installDom();
  saves.length = 0;
  saveResult = { ok: true };
  backfills = 0;
  requests = [];
  popupUrl = "";
  secretWrites = 0;
  connectedCalls = 0;
  closed = 0;
  const synthetic = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.origin === backend && url.pathname === "/api/connectors/google/oauth/exchange") {
      return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
        scope: CALENDAR_SCOPE, grant: GRANT });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = synthetic;
  window.fetch = synthetic;
  const previousOpen = Object.getOwnPropertyDescriptor(window, "open");
  Object.defineProperty(window, "open", { configurable: true, value: () => {
    const popup = { closed: false, close() { this.closed = true; }, location: {} };
    Object.defineProperty(popup.location, "href", { set(value: string) { popupUrl = value; } });
    return popup;
  } });
  restoreOpen = () => {
    if (previousOpen) Object.defineProperty(window, "open", previousOpen);
    else Reflect.deleteProperty(window, "open");
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConnectorConnectDialog tcw={tcw} descriptor={descriptor} backendUrl={backend}
    purpose="calendar-link"
    sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore}
    open onOpenChange={(next) => { if (!next) closed++; }} onConnected={() => { connectedCalls++; }} />));
  await settle();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  globalThis.fetch = realFetch;
  restoreOpen?.();
  restoreOpen = undefined;
  restoreDom?.();
  restoreDom = undefined;
});
afterAll(() => restoreImportDom());

test("the consent shown is Calendar linking's own", () => {
  expect(dialog().textContent).toContain("Link Google Calendar");
  expect(dialog().textContent).toContain("It never joins meetings, sends a notetaker or changes your calendar.");
  expect(dialog().textContent).not.toContain("Meet transcripts");
  expect(dialog().textContent).not.toContain("sends a notetaker to Google Meet");
});

test("the start URL and the exchange carry the purpose; the token goes to linking's own store and the dialog closes", async () => {
  const start = await authorize();
  expect(start.origin).toBe(backend);
  expect(start.pathname).toBe("/api/connectors/google/oauth/start");
  expect(start.searchParams.get("purpose")).toBe("calendar-link");
  expect(start.searchParams.get("challenge")).toBeTruthy();
  await until(() => closed === 1, "expected the dialog to close once the link is saved");

  const exchange = requests.filter((request) => request.path === "/api/connectors/google/oauth/exchange");
  expect(exchange).toHaveLength(1);
  expect(exchange[0]!.body).toMatchObject({ code: "synthetic-authorization-code", purpose: "calendar-link" });
  expect(saves).toEqual([{ refreshToken: "synthetic-refresh", desktop: false, scope: CALENDAR_SCOPE, grant: GRANT }]);
  expect(connectedCalls).toBe(1);
  // Existing notes start linking, and nothing waited for them.
  expect(backfills).toBe(1);
  // No Google Meet secret, no Meet sync, no autojoin route.
  expect(secretWrites).toBe(0);
  expect(requests.filter((request) => request.path.includes("/autojoin/"))).toEqual([]);
  expect(requests.map((request) => request.path)).toEqual(["/api/connectors/google/oauth/exchange"]);
});

test("a grant without the calendar permission says so and connects nothing", async () => {
  saveResult = { ok: false, reason: "scope" };
  await authorize();
  await until(() => dialog().querySelector('[role="alert"]') !== null, "expected the scope refusal to be shown");
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(
    "Google didn't grant calendar access. Try again and leave the calendar permission ticked.");
  expect(closed).toBe(0);
  expect(connectedCalls).toBe(0);
  expect(backfills).toBe(0);
  expect(secretWrites).toBe(0);
  // No Meet sync exists to retry: the only way on is to close and link again.
  const labels = [...dialog().querySelectorAll("button")].map((entry) => entry.textContent?.trim());
  expect(labels).toContain("Close");
  expect(labels).not.toContain("Retry");
});

test("a server without the Google OAuth routes is named as that, not as Google Meet", async () => {
  globalThis.fetch = (async () => Response.json({ error: "not_found" }, { status: 404 })) as typeof fetch;
  window.fetch = globalThis.fetch;
  await authorize();
  await until(() => dialog().querySelector('[role="alert"]') !== null, "expected the unavailable sentence");
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("Calendar linking isn't available on this server.");
  expect(saves).toEqual([]);
  expect(connectedCalls).toBe(0);
});
