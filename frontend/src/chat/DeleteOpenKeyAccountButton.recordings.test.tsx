import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";

const RECORDINGS = "https://api.example/api/transcriber/meetings";
const CREDS = "https://api.example/api/connectors/credentials/fireflies";
const DISCONNECT = "https://api.example/api/connectors/google/autojoin/disconnect";
const CONFIG = "https://api.example/api/connectors/webhooks/config";
const GRANT = "https://api.example/api/connectors/fireflies/delegation";
const DELEGATION = "https://api.example/api/delegations";
const EXO = "https://api.example/api/exo/v1/grant";
const TOKEN = "private-recording-session-sentinel";
const success = { removed: 2, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 1 };
let cleanDom: (() => void) | undefined;
const originalFetch = globalThis.fetch;
let calls: string[];
let replies: Array<{ status: number; body?: unknown }>;
beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { cleanDom?.(); });
beforeEach(() => {
  calls = [];
  replies = [{ status: 200, body: success }];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === RECORDINGS) {
      const next = replies.shift();
      if (!next) throw new Error(`network failed Bearer ${TOKEN}`);
      return Response.json(next.body ?? {}, { status: next.status });
    }
    return Response.json(init?.method === "DELETE" ? { deleted: true, upstreamRevoked: true } : { connected: true });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function page(run: (view: { host: HTMLElement; opens: () => number; click: (label: string) => Promise<void> }) => Promise<void>) {
  // Load after installDom: browser-only dependencies require the DOM globals at module evaluation.
  const { DeleteOpenKeyAccountButton } = await import("./DeleteOpenKeyAccountButton");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let opens = 0;
  try {
    await act(async () => root.render(<DeleteOpenKeyAccountButton backendUrl="https://api.example" sessionStore={{ getToken: () => TOKEN, isExpired: () => false } as unknown as SessionStore} openDeletionPage={async () => { opens++; }} />));
    await run({ host, opens: () => opens, click: async (label) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button).toBeDefined();
      await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    } });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test("account deletion purges recordings before credential teardown and OpenKey", async () => {
  await page(async (view) => {
    await view.click("Delete OpenKey account");
    expect(calls).toEqual([`POST ${DISCONNECT}`, `DELETE ${RECORDINGS}`, `GET ${CREDS}`, `DELETE ${CREDS}`, `DELETE ${CONFIG}`, `DELETE ${GRANT}`, `DELETE ${DELEGATION}`, `DELETE ${EXO}`]);
    expect(view.opens()).toBe(1);
  });
});

for (const [name, response] of [
  ["pending", { status: 202, body: { ...success, deleting: 1 } }],
  ["failed", { status: 503 }],
  ["not attributed", { status: 200, body: { ...success, notDeleted: 1, listOnly: 1 } }],
] as const) {
  test(`${name} purge is disclosed before continue, which still tears down credentials`, async () => {
    replies = [response];
    await page(async (view) => {
      await view.click("Delete OpenKey account");
      expect(view.opens()).toBe(0);
      expect(calls).toEqual([`POST ${DISCONNECT}`, `DELETE ${RECORDINGS}`]);
      expect(view.host.querySelector("[role=alert]")?.textContent).toBeTruthy();
      if (name === "pending") expect(view.host.textContent).toContain("we keep deleting them after it's gone");
      if (name === "failed") expect(view.host.textContent).toContain("Some may still be there");
      if (name === "not attributed") expect(view.host.textContent).toContain("still with the notetaker service");
      await view.click("Continue to OpenKey");
      expect(calls).toEqual([`POST ${DISCONNECT}`, `DELETE ${RECORDINGS}`, `GET ${CREDS}`, `DELETE ${CREDS}`, `DELETE ${CONFIG}`, `DELETE ${GRANT}`, `DELETE ${DELEGATION}`, `DELETE ${EXO}`]);
      expect(view.opens()).toBe(1);
    });
  });
}

test("retry reissues the recordings purge before advancing", async () => {
  replies = [{ status: 503 }, { status: 200, body: success }];
  await page(async (view) => {
    await view.click("Delete OpenKey account");
    await view.click("Try again");
    expect(calls).toEqual([`POST ${DISCONNECT}`, `DELETE ${RECORDINGS}`, `DELETE ${RECORDINGS}`, `GET ${CREDS}`, `DELETE ${CREDS}`, `DELETE ${CONFIG}`, `DELETE ${GRANT}`, `DELETE ${DELEGATION}`, `DELETE ${EXO}`]);
    expect(view.opens()).toBe(1);
  });
});

test("a network exception containing the session token is never rendered", async () => {
  replies = [];
  await page(async (view) => {
    await view.click("Delete OpenKey account");
    expect(view.opens()).toBe(0);
    expect(view.host.querySelector("[role=alert]")).not.toBeNull();
    expect(view.host.textContent).not.toContain(TOKEN);
  });
});
