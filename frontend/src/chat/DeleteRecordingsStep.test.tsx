import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { NOT_DELETED } from "./recordingsDeletedCopy";

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

test("(1) own only, confirmed: no counts, the same line for one or many", async () => {
  expect(await run({ status: 200, body: { removed: 3, deleting: 0, listOnly: 0, notDeleted: 0 } })).toBe("Your meeting recordings are deleted, including the notetaker service's copies.");
  expect(await run({ status: 200, body: { removed: 1, deleting: 0, listOnly: 0, notDeleted: 0 } })).toBe("Your meeting recordings are deleted, including the notetaker service's copies.");
});

test("(2) own and shared: the shared ones are said to be only removed from the list", async () => {
  expect(await run({ status: 200, body: { removed: 4, deleting: 0, listOnly: 2, notDeleted: 0 } })).toBe(`Your meeting recordings are deleted, including the notetaker service's copies. ${SHARED}`);
  expect(await run({ status: 200, body: { removed: 2, deleting: 0, listOnly: 1, notDeleted: 0 } })).toBe(`Your meeting recordings are deleted, including the notetaker service's copies. ${SHARED}`);
});

test("(3) shared only: nothing is called deleted", async () => {
  const text = await run({ status: 200, body: { removed: 2, deleting: 0, listOnly: 2, notDeleted: 0 } });
  expect(text).toBe(`You had no meeting recordings of your own to delete. ${SHARED}`);
});

test("(4) nothing to delete, and the feature being dark", async () => {
  expect(await run({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0 } })).toBe("You have no meeting recordings to delete.");
  expect(await run({ status: 404, body: { error: "not_found" } })).toBe("You have no meeting recordings to delete.");
});

test("an own entry the provider did not attribute to the account is not reported as deleted, shared, or missing", async () => {
  const only = await run({ status: 200, body: { removed: 1, deleting: 0, listOnly: 0, notDeleted: 1 } });
  expect(only).toBe(NOT_DELETED);
  expect(only).not.toMatch(/\b(is|are) deleted\b/);
  expect(only).not.toContain("had no meeting recordings of your own");
  expect(await run({ status: 200, body: { removed: 4, deleting: 0, listOnly: 1, notDeleted: 1 } })).toBe(`Your meeting recordings are deleted, including the notetaker service's copies. ${NOT_DELETED} ${SHARED}`);
});

test("an own delete still pending, or the request failing, never says deleted", async () => {
  const pending = await run({ status: 202, body: { removed: 2, deleting: 1, listOnly: 0, notDeleted: 0 } });
  expect(pending).toBe("Your meeting recordings are being deleted. We keep trying until each one is gone.");
  expect(pending).not.toMatch(/\b(is|are) deleted\b/);
  expect(await run({ status: 202, body: { removed: 3, deleting: 1, listOnly: 2, notDeleted: 0 } })).toBe(`Your meeting recordings are being deleted. We keep trying until each one is gone. ${SHARED}`);
  const failed = await run({ status: 503, body: { error: "transcriber_unavailable", removed: 1, deleting: 0, listOnly: 0, notDeleted: 0, failed: 1 } });
  expect(failed).toContain("We couldn't finish deleting your recordings");
  expect(failed).not.toMatch(/Your (meeting )?recordings? (is|are) deleted/);
});

test("a backend that cannot say which removals were real deletes (an older one) never yields a 'deleted' claim", async () => {
  const text = await run({ status: 200, body: { removed: 3, deleting: 0 } });
  expect(text).toContain("We couldn't finish deleting your recordings");
  expect(text).not.toMatch(/Your (meeting )?recordings? (is|are) deleted/);
});

test("the intro says it deletes the user's own recordings, not every recording they can see", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const { DeleteRecordingsStep } = await import("./DeleteRecordingsStep"); // after installDom, as above
    await act(async () => {
      root.render(<DeleteRecordingsStep backendUrl="https://api.example" sessionStore={{ getToken: () => "t", isExpired: () => false } as unknown as SessionStore} />);
    });
    expect(host.textContent).toContain("Before you delete your account, delete your recordings. This permanently deletes your meeting recordings and transcripts, including the notetaker service's copies.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
