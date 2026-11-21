import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";

// React DOM and Radix detect browser support at import time.
const restoreDom = installDom();
const { createRoot } = await import("react-dom/client");
afterAll(restoreDom);
const { ConnectorConnectDialog } = await import("@/chat/ConnectorDialog");
const { ConnectorsCard } = await import("@/chat/ConnectorsCard");
const { CONNECTORS } = await import("@/lib/connectors/registry");
const granola = CONNECTORS.find(({ id }) => id === "granola")!;
const tcw = { sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }) }) } } as unknown as TinyCloudWeb;
const sessionStore = { getToken: () => null } as unknown as SessionStore;
const backendUrl = "https://backend.invalid";

test("an unknown connector refuses key entry and never contacts Fireflies", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return new Response("{}", { status: 401 });
  }, { preconnect: realFetch.preconnect });
  try {
    await act(async () => root.render(<ConnectorConnectDialog tcw={tcw} backendUrl={backendUrl}
      sessionStore={sessionStore} descriptor={{ ...granola, id: "unknown-fixture" as typeof granola.id, status: "available" }} open
      onOpenChange={() => {}} onConnected={() => {}} />));
    const dialog = document.querySelector('[role="dialog"]');
    const input = dialog?.querySelector("input");
    if (input) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "grn_fixture_only");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    }
    expect(calls).toEqual([]);
    expect(Boolean(input)).toBe(false);
    expect(dialog?.textContent).toContain("not available yet");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
  }
});

test("flag-off Granola stays coming soon without a Settings Connect button", async () => {
  expect(import.meta.env.VITE_GRANOLA_CONNECTOR_ENABLED).toBe("false");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryRouter><ConnectorsCard tcw={tcw} backendUrl={backendUrl}
      sessionStore={sessionStore} /></MemoryRouter>));
    expect(Boolean(host.querySelector('button[aria-label="Connect Fireflies"]'))).toBe(true);
    expect(Boolean(host.querySelector('button[aria-label="Connect Granola"]'))).toBe(false);
    expect(host.querySelector('[aria-label="Granola — coming soon"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
