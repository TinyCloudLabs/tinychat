import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE } from "@/lib/connectors/webhooksApi";

// Account deletion removes the Fireflies sign-in our server may hold BEFORE OpenKey's page opens, and a
// failed clean-up never blocks the deletion. Real component and client, stubbed network.

const SENTINEL = "sentinel-session-token-55d1e0aa";
const CREDS = "https://api.example/api/connectors/credentials/fireflies";

let cleanDom: (() => void) | undefined;
const realFetch = globalThis.fetch;
const spies: Array<{ mockRestore: () => void }> = [];
let calls: string[];
let logged: string[];
let responses: Record<string, Array<{ status: number; body?: unknown; headers?: Record<string, string> }>>;

beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { cleanDom?.(); });
beforeEach(() => {
  calls = [];
  logged = [];
  responses = {};
  for (const level of ["log", "info", "warn", "error"] as const) {
    spies.push(spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    if (key === "DELETE https://api.example/api/transcriber/meetings") {
      return Response.json({ removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null });
    }
    if (responses[key] === undefined && key === "DELETE https://api.example/api/connectors/webhooks/purged") return new Response(null, { status: 204 });
    if (responses[key] === undefined && (key === "DELETE https://api.example/api/connectors/webhooks/config" || key === "DELETE https://api.example/api/connectors/fireflies/delegation")) return Response.json({});
    if (responses[key] === undefined && key === "POST https://api.example/api/connectors/google/autojoin/disconnect") return Response.json({ upstreamRevoked: "not_applicable" });
    if (responses[key] === undefined && (key === "DELETE https://api.example/api/delegations" || key === "DELETE https://api.example/api/exo/v1/grant")) return Response.json({});
    const next = responses[key]?.[0];
    if (!next) throw new Error(`no answer for ${key} Bearer ${SENTINEL}`);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length > 0) spies.pop()!.mockRestore();
});

async function mount(): Promise<{ host: HTMLElement; opened: () => number; click: (label: string) => Promise<void>; unmount: () => Promise<void> }> {
  const { DeleteOpenKeyAccountButton } = await import("./DeleteOpenKeyAccountButton");
  const sessionStore = { getToken: () => SENTINEL, isExpired: () => false } as unknown as SessionStore;
  let opens = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DeleteOpenKeyAccountButton backendUrl="https://api.example" sessionStore={sessionStore} openDeletionPage={async () => { opens += 1; }} />);
  });
  return {
    host,
    opened: () => opens,
    click: async (label) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button).toBeDefined();
      await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

const connected = { status: 200, body: { connected: true } };

test("a stored sign-in is torn down once, then OpenKey opens", async () => {
  responses = { [`GET ${CREDS}`]: [connected], [`DELETE ${CREDS}`]: [{ status: 200, body: { deleted: true, upstreamRevoked: true } }] };
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).toEqual(["POST https://api.example/api/connectors/google/autojoin/disconnect", "DELETE https://api.example/api/transcriber/meetings", `GET ${CREDS}`, `DELETE ${CREDS}`, "DELETE https://api.example/api/connectors/webhooks/config", "DELETE https://api.example/api/connectors/fireflies/delegation", "DELETE https://api.example/api/delegations", "DELETE https://api.example/api/exo/v1/grant", "DELETE https://api.example/api/connectors/webhooks/purged", "DELETE https://api.example/api/connectors/webhooks/purged"]);
  expect(page.opened()).toBe(1);
  expect(page.host.querySelector("[role=alert]")).toBeNull();
  await page.unmount();
});

test("not connected: the full DELETE is sent once, no message, OpenKey opens", async () => {
  responses = {
    [`GET ${CREDS}`]: [{ status: 200, body: { connected: false } }],
    [`DELETE ${CREDS}`]: [{ status: 200, body: { deleted: true, upstreamRevoked: false } }],
  };
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).toEqual(["POST https://api.example/api/connectors/google/autojoin/disconnect", "DELETE https://api.example/api/transcriber/meetings", `GET ${CREDS}`, `DELETE ${CREDS}`, "DELETE https://api.example/api/connectors/webhooks/config", "DELETE https://api.example/api/connectors/fireflies/delegation", "DELETE https://api.example/api/delegations", "DELETE https://api.example/api/exo/v1/grant", "DELETE https://api.example/api/connectors/webhooks/purged", "DELETE https://api.example/api/connectors/webhooks/purged"]);
  expect(page.opened()).toBe(1);
  expect(page.host.querySelector("[role=alert]")).toBeNull();
  await page.unmount();
});

test("the route dark: no DELETE, no message, OpenKey opens", async () => {
  responses = { [`GET ${CREDS}`]: [{ status: 404, headers: { "X-Route-Unavailable": "connector-credentials" } }] };
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).toEqual(["POST https://api.example/api/connectors/google/autojoin/disconnect", "DELETE https://api.example/api/transcriber/meetings", `GET ${CREDS}`, "DELETE https://api.example/api/connectors/webhooks/config", "DELETE https://api.example/api/connectors/fireflies/delegation", "DELETE https://api.example/api/delegations", "DELETE https://api.example/api/exo/v1/grant", "DELETE https://api.example/api/connectors/webhooks/purged", "DELETE https://api.example/api/connectors/webhooks/purged"]);
  expect(page.opened()).toBe(1);
  expect(page.host.querySelector("[role=alert]")).toBeNull();
  await page.unmount();
});

test("502 upstream_revoke_failed: the notice shows and OpenKey opens only on continue", async () => {
  responses = {
    [`GET ${CREDS}`]: [connected],
    [`DELETE ${CREDS}`]: [{ status: 502, body: { error: "upstream_revoke_failed", deleted: true } }],
  };
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.host.querySelector("[role=alert]")?.textContent).toBe(CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE);
  expect(page.opened()).toBe(0);
  expect([...page.host.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(false);
  await page.click("Continue to OpenKey");
  expect(page.opened()).toBe(1);
  expect(calls.filter((c) => c === `DELETE ${CREDS}`)).toHaveLength(1);
  await page.unmount();
});

test("503: the failure shows, the owner can try again or continue anyway", async () => {
  responses = {
    [`GET ${CREDS}`]: [connected],
    [`DELETE ${CREDS}`]: [{ status: 503, body: { error: "revoke_failed" } }],
  };
  const page = await mount();
  await page.click("Delete OpenKey account");
  const alert = page.host.querySelector("[role=alert]")?.textContent ?? "";
  expect(alert).toBe("The server is temporarily unavailable (503). We couldn't confirm your Fireflies sign-in was removed from our server. Try again, or continue to OpenKey and revoke it yourself in your Fireflies account.");
  expect(page.opened()).toBe(0);
  await page.click("Try again");
  expect(calls.filter((c) => c === `DELETE ${CREDS}`)).toHaveLength(2);
  await page.click("Continue to OpenKey");
  expect(page.opened()).toBe(1);
  await page.unmount();
});

test("the session token appears in no log, message or error, even when the network fails", async () => {
  responses = {};
  const page = await mount();
  await page.click("Delete OpenKey account");
  const shown = page.host.textContent ?? "";
  expect(shown).toContain("Couldn't reach the server.");
  expect(shown + logged.join("\n")).not.toContain(SENTINEL);
  await page.click("Continue to OpenKey");
  expect(page.opened()).toBe(1);
  await page.unmount();
});

test("the failure text joins each reason with a single space and no doubled full stop", async () => {
  const { accountDeletionTeardownFailure } = await import("./DeleteOpenKeyAccountButton");
  const reasons = [
    { status: "unauthenticated" },
    { status: "offline" },
    { status: "retryable", httpStatus: 503, code: null },
    { status: "rejected", httpStatus: 400, code: "bad_request" },
    { status: "rejected", httpStatus: 400, code: null },
    { status: "feature-dark" },
  ] as const;
  for (const reason of reasons) {
    const text = accountDeletionTeardownFailure(reason);
    expect(text).not.toContain("..");
    expect(text).not.toContain("  ");
    expect(text).toContain(" We couldn't confirm your Fireflies sign-in was removed from our server.");
  }
});

test("a 404 the backend did not mark is a failure: the text shows, Try again and Continue to OpenKey are offered, no DELETE", async () => {
  responses = { [`GET ${CREDS}`]: [{ status: 404, body: { error: "not_found" } }] };
  const page = await mount();
  await page.click("Delete OpenKey account");
  const alert = page.host.querySelector("[role=alert]")?.textContent ?? "";
  expect(alert).toContain("We couldn't confirm your Fireflies sign-in was removed from our server.");
  expect(page.opened()).toBe(0);
  expect([...page.host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
  expect(calls.filter((c) => c === `DELETE ${CREDS}`)).toHaveLength(0);
  await page.click("Continue to OpenKey");
  expect(page.opened()).toBe(1);
  await page.unmount();
});
