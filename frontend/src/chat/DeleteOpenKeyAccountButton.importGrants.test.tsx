import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE } from "@/lib/connectors/connectorLifecycle";

// Account deletion takes the Fireflies import permissions from the server and revokes both at the node before
// OpenKey's page opens. Real component and clients, stubbed network and node.

const SENTINEL = "sentinel-session-token-77c3";
const OWNER = "0xabc0000000000000000000000000000000000001";
const BASE = "https://api.example";
const GRANT = `${BASE}/api/connectors/fireflies/delegation`;
const CREDS = `${BASE}/api/connectors/credentials/fireflies`;
const PENDING_KEY = `tinychat:fireflies-import-pending-revokes:${OWNER}`;

let cleanDom: (() => void) | undefined;
const realFetch = globalThis.fetch;
const spies: Array<{ mockRestore: () => void }> = [];
let calls: string[];
let answers: Record<string, { status: number; body?: unknown }>;

const rows = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => rows.get(key) ?? null,
  setItem: (key: string, value: string) => void rows.set(key, value),
  removeItem: (key: string) => void rows.delete(key),
  clear: () => rows.clear(),
} as unknown as Storage;

beforeAll(() => { cleanDom = installDom({ localStorage: memoryStorage }); });
afterAll(() => { cleanDom?.(); });
beforeEach(() => {
  calls = [];
  answers = {};
  localStorage.clear();
  for (const level of ["log", "info", "warn", "error"] as const) spies.push(spyOn(console, level).mockImplementation(() => {}));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    if (key === `DELETE ${BASE}/api/transcriber/meetings`) {
      return Response.json({ removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null });
    }
    const next = answers[key];
    if (!next) throw new Error(`no answer for ${key} Bearer ${SENTINEL}`);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.clear();
  while (spies.length > 0) spies.pop()!.mockRestore();
});

async function mount(revokeResults: Record<string, boolean>) {
  // Loaded after installDom: browser-only dependencies need the DOM globals at module evaluation.
  const { DeleteOpenKeyAccountButton } = await import("./DeleteOpenKeyAccountButton");
  const sessionStore = { getToken: () => SENTINEL, isExpired: () => false, getAddress: () => OWNER } as unknown as SessionStore;
  const revoked: string[] = [];
  const tcw = {
    revokeDelegation: async (cid: string) => {
      revoked.push(cid);
      return { ok: revokeResults[cid] ?? true };
    },
  };
  let opens = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <DeleteOpenKeyAccountButton
        backendUrl={BASE}
        sessionStore={sessionStore}
        tcw={tcw as never}
        openDeletionPage={async () => { opens += 1; }}
      />,
    );
  });
  return {
    host,
    revoked,
    opened: () => opens,
    click: async (label: string) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button).toBeDefined();
      await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

const credsGone = {
  [`GET ${CREDS}`]: { status: 200, body: { connected: true } },
  [`DELETE ${CREDS}`]: { status: 200, body: { deleted: true, upstreamRevoked: true } },
};

test("the two permissions are listed, taken from the server and revoked at the node before OpenKey opens", async () => {
  answers = {
    [`GET ${GRANT}/grants`]: { status: 200, body: { grantCids: ["cid-secrets", "cid-meetings"] } },
    [`DELETE ${GRANT}`]: { status: 200, body: { state: "none", expiresAt: null } },
    ...credsGone,
  };
  const page = await mount({});
  await page.click("Delete OpenKey account");

  expect(calls).toEqual([
    `DELETE ${BASE}/api/transcriber/meetings`,
    `GET ${GRANT}/grants`,
    `DELETE ${GRANT}`,
    `GET ${CREDS}`,
    `DELETE ${CREDS}`,
  ]);
  expect(page.revoked).toEqual(["cid-secrets", "cid-meetings"]);
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(page.opened()).toBe(1);
  expect(page.host.querySelector("[role=alert]")).toBeNull();
  await page.unmount();
});

test("a server that did not take its copy away stops the deletion with a retry, and nothing is revoked or removed after it", async () => {
  answers = {
    [`GET ${GRANT}/grants`]: { status: 200, body: { grantCids: ["cid-secrets", "cid-meetings"] } },
    [`DELETE ${GRANT}`]: { status: 503, body: { error: "unavailable" } },
  };
  const page = await mount({});
  await page.click("Delete OpenKey account");

  expect(calls).toEqual([`DELETE ${BASE}/api/transcriber/meetings`, `GET ${GRANT}/grants`, `DELETE ${GRANT}`]);
  expect(page.revoked).toEqual([]);
  expect(page.opened()).toBe(0);
  expect(page.host.querySelector("[role=alert]")?.textContent).toContain("permission to import your Fireflies meetings");
  // The ids stay owed, so the retry still revokes them.
  expect(localStorage.getItem(PENDING_KEY)).toContain("cid-secrets");
  expect([...page.host.querySelectorAll("button")].map((b) => b.textContent)).toContain("Try again");
  await page.unmount();
});

test("a permission the node did not confirm revoked is disclosed, stays owed, and OpenKey opens only on continue", async () => {
  answers = {
    [`GET ${GRANT}/grants`]: { status: 200, body: { grantCids: ["cid-secrets", "cid-meetings"] } },
    [`DELETE ${GRANT}`]: { status: 200, body: { state: "none", expiresAt: null } },
    ...credsGone,
  };
  const page = await mount({ "cid-meetings": false });
  await page.click("Delete OpenKey account");

  expect(page.host.querySelector("[role=alert]")?.textContent).toContain(IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE);
  expect(page.opened()).toBe(0);
  expect(localStorage.getItem(PENDING_KEY)).toContain("cid-meetings");
  expect(localStorage.getItem(PENDING_KEY)).not.toContain("cid-secrets");

  await page.click("Continue to OpenKey");
  expect(page.opened()).toBe(1);
  await page.unmount();
});

test("a permission this browser still owes a revoke is revoked even when the server already dropped its copy", async () => {
  localStorage.setItem(PENDING_KEY, JSON.stringify([{ cid: "cid-owed", at: Date.now() }]));
  answers = {
    [`GET ${GRANT}/grants`]: { status: 200, body: { grantCids: [] } },
    [`DELETE ${GRANT}`]: { status: 200, body: { state: "none", expiresAt: null } },
    ...credsGone,
  };
  const page = await mount({});
  await page.click("Delete OpenKey account");

  expect(page.revoked).toEqual(["cid-owed"]);
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(page.opened()).toBe(1);
  await page.unmount();
});
