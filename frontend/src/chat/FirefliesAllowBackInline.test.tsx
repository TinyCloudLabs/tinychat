import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { CONNECTORS_KV_PREFIX } from "@/lib/connectors/connectorStore";
import { GranolaAllowBack } from "./GranolaAllowBack";

const backend = "https://api.example";
const marker = `${CONNECTORS_KV_PREFIX}/fireflies/deleted/${"a".repeat(64)}`;
const realFetch = globalThis.fetch;
let cleanDom: (() => void) | undefined;

beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { cleanDom?.(); });
afterEach(() => { globalThis.fetch = realFetch; });

async function mount(calls: string[], deletedStatuses: number[]) {
  const tcw = { kv: {
    list: async ({ path }: { path: string }) => { calls.push(`owner:list:${path}`); return { ok: true, data: { keys: [marker], truncated: false } }; },
    delete: async (key: string) => { calls.push(`owner:delete:${key}`); return { ok: true, data: undefined }; },
  } } as unknown as TinyCloudWeb;
  const sessionStore = { getToken: () => "test-session", isExpired: () => false } as unknown as SessionStore;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(`backend:${path}`);
    if (path.endsWith("/deleted")) {
      const status = deletedStatuses.shift() ?? 503;
      return new Response(status === 204 ? null : JSON.stringify({ error: "unavailable" }), { status });
    }
    if (path.endsWith("/purged")) return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<GranolaAllowBack source="fireflies" buttonClassName="ms-btn2 ms-btn-wrap" note="After this, Fireflies syncs can bring back meetings you deleted." tcw={tcw} backendUrl={backend} sessionStore={sessionStore} />));
  const click = async (label: string) => {
    const button = [...node.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  return { node, click, unmount: async () => { await act(async () => root.unmount()); node.remove(); } };
}

test("Fireflies allow-back has one inline confirmation and hides its note while confirming", async () => {
  const view = await mount([], [204]);
  try {
    await view.click("Allow deleted Fireflies meetings back");
    expect(view.node.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Allow deleted Fireflies meetings back?");
    expect(view.node.textContent).toContain("We keep a list of the Fireflies meetings you deleted");
    expect(view.node.textContent).not.toContain("After this, Fireflies syncs can bring back meetings you deleted.");
    expect([...view.node.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Allow them back", "Keep them deleted"]);
  } finally { await view.unmount(); }
});

test("Fireflies allow-back clears backend markers, ledger and owner markers in that order", async () => {
  const calls: string[] = [];
  const view = await mount(calls, [204]);
  try {
    await view.click("Allow deleted Fireflies meetings back");
    await view.click("Allow them back");
    expect(calls).toEqual([
      "backend:/api/connectors/webhooks/deleted",
      "backend:/api/connectors/webhooks/purged",
      `owner:list:${CONNECTORS_KV_PREFIX}/fireflies/deleted/`,
      `owner:delete:${marker}`,
    ]);
    expect(view.node.querySelector('[role="status"]')?.textContent).toBe("Deleted meetings can come back from your next Fireflies sync.");
  } finally { await view.unmount(); }
});

test("Fireflies allow-back shows retry and keeps owner markers when backend marker clear fails", async () => {
  const calls: string[] = [];
  const view = await mount(calls, [503, 204]);
  try {
    await view.click("Allow deleted Fireflies meetings back");
    await view.click("Allow them back");
    expect(view.node.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    expect(calls).toEqual(["backend:/api/connectors/webhooks/deleted"]);
    await view.click("Try again");
    await view.click("Allow them back");
    expect(calls.slice(1)).toEqual([
      "backend:/api/connectors/webhooks/deleted",
      "backend:/api/connectors/webhooks/purged",
      `owner:list:${CONNECTORS_KV_PREFIX}/fireflies/deleted/`,
      `owner:delete:${marker}`,
    ]);
  } finally { await view.unmount(); }
});
