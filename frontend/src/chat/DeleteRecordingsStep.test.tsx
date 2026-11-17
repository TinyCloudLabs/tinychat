import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";

// TC-3136: the step's wording follows what the backend CONFIRMED. Real component, stubbed network.

let cleanDom: (() => void) | undefined;
const realFetch = globalThis.fetch;
beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { globalThis.fetch = realFetch; cleanDom?.(); });

const SHARED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";

async function run(response: { status: number; body: unknown }): Promise<string> {
  globalThis.fetch = (async () => new Response(JSON.stringify(response.body), { status: response.status })) as typeof fetch;
  // Loaded after beforeAll installs the DOM (its imports read window at load), so a static import cannot work.
  const { DeleteRecordingsStep } = await import("./DeleteRecordingsStep");
  const sessionStore = { getToken: () => "t", isExpired: () => false } as unknown as SessionStore;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<DeleteRecordingsStep backendUrl="https://api.example" sessionStore={sessionStore} />); });
    const click = async (label: string) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button).toBeDefined();
      await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    };
    await click("Delete my recordings first");
    await click("Yes, delete all my recordings");
    for (let i = 0; i < 10 && !host.querySelector("[role=status]:not(:empty)"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return host.querySelector("[role=status]")?.textContent ?? host.querySelector("[role=alert]")?.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test("(1) own only, confirmed: no counts; exactly one reads singular", async () => {
  expect(await run({ status: 200, body: { removed: 3, deleting: 0, listOnly: 0 } })).toBe("Your recordings are deleted.");
  expect(await run({ status: 200, body: { removed: 1, deleting: 0, listOnly: 0 } })).toBe("Your recording is deleted.");
});

test("(2) own and shared: the shared ones are said to be only removed from the list", async () => {
  expect(await run({ status: 200, body: { removed: 4, deleting: 0, listOnly: 2 } })).toBe(`Your recordings are deleted. ${SHARED}`);
  expect(await run({ status: 200, body: { removed: 2, deleting: 0, listOnly: 1 } })).toBe(`Your recording is deleted. ${SHARED}`);
});

test("(3) shared only: nothing is called deleted", async () => {
  const text = await run({ status: 200, body: { removed: 2, deleting: 0, listOnly: 2 } });
  expect(text).toBe(`You had no recordings of your own to delete. ${SHARED}`);
});

test("(4) nothing to delete, and the feature being dark", async () => {
  expect(await run({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0 } })).toBe("You have no recordings to delete.");
  expect(await run({ status: 404, body: { error: "not_found" } })).toBe("You have no recordings to delete.");
});

test("an own delete still pending, or the request failing, never says deleted", async () => {
  const pending = await run({ status: 202, body: { removed: 2, deleting: 1, listOnly: 0 } });
  expect(pending).toBe("Deleting… this isn't finished yet. We keep retrying until it's confirmed gone.");
  expect(pending).not.toMatch(/\bdeleted\b/);
  expect(await run({ status: 202, body: { removed: 3, deleting: 1, listOnly: 2 } })).toBe(`Deleting… this isn't finished yet. We keep retrying until it's confirmed gone. ${SHARED}`);
  const failed = await run({ status: 503, body: { error: "transcriber_unavailable", removed: 1, deleting: 0, listOnly: 0, failed: 1 } });
  expect(failed).toContain("We couldn't finish deleting your recordings");
  expect(failed).not.toMatch(/Your recordings? (is|are) deleted/);
});
