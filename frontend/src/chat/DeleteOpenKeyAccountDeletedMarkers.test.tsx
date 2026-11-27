import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { DeleteOpenKeyAccountButton } from "./DeleteOpenKeyAccountButton";

const base = "https://api.example";
const deleted = `${base}/api/connectors/webhooks/deleted`;
const realFetch = globalThis.fetch;
let cleanDom: (() => void) | undefined;

beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { cleanDom?.(); });
afterEach(() => { globalThis.fetch = realFetch; });

async function mount(opened: { count: number }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessionStore = { getToken: () => "test-session", isExpired: () => false } as unknown as SessionStore;
  await act(async () => root.render(<DeleteOpenKeyAccountButton backendUrl={base} sessionStore={sessionStore} openDeletionPage={async () => { opened.count++; }} />));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  return { host, click, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

function stubFetch(deletedStatuses: number[], calls: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push(`${method} ${url}`);
    if (method === "DELETE" && url === deleted) {
      const status = deletedStatuses.shift() ?? 503;
      return new Response(status === 204 ? null : JSON.stringify({ error: "unavailable" }), { status });
    }
    if (method === "DELETE" && url.endsWith("/api/transcriber/meetings"))
      return Response.json({ removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null });
    if (method === "DELETE" && url.endsWith("/api/connectors/fireflies/delegation"))
      return Response.json({ state: "none", expiresAt: null });
    if (method === "GET" && url.endsWith("/api/connectors/credentials/fireflies"))
      return Response.json({ connected: false });
    if (method === "DELETE" && url.endsWith("/api/connectors/credentials/fireflies"))
      return Response.json({ deleted: true, upstreamRevoked: false });
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;
}

test("account deletion clears the Fireflies deletion markers prior to OpenKey", async () => {
  const calls: string[] = [];
  const opened = { count: 0 };
  stubFetch([204], calls);
  const page = await mount(opened);
  try {
    await page.click("Delete OpenKey account");
    expect(calls.at(-1)).toBe(`DELETE ${deleted}`);
    expect(opened.count).toBe(1);
  } finally { await page.unmount(); }
});

test("failed marker erase blocks OpenKey until a successful retry", async () => {
  const calls: string[] = [];
  const opened = { count: 0 };
  stubFetch([503, 204], calls);
  const page = await mount(opened);
  try {
    await page.click("Delete OpenKey account");
    expect(opened.count).toBe(0);
    expect(page.host.querySelector("[role=alert]")?.textContent).toContain("deleted Fireflies meeting");
    expect([...page.host.querySelectorAll("button")].some((button) => button.textContent === "Continue to OpenKey")).toBe(false);
    await page.click("Try again");
    expect(calls.filter((call) => call === `DELETE ${deleted}`)).toHaveLength(2);
    expect(opened.count).toBe(1);
  } finally { await page.unmount(); }
});
