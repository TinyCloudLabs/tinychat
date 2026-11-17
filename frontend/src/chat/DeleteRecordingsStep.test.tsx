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
const OWN = "Your meeting recordings, voice notes and uploads are deleted from the notetaker service and TinyCloud Private Transcription.";
const FAILED = "We couldn't finish deleting your recordings, voice notes and uploads. Some may still be there. Try again in a moment.";
const STILL = "Your voice notes and uploads are deleted. Your meeting recordings are being deleted; we keep trying until each one is gone.";

const PRIVATE_CLOUD_ON = { status: 200, body: { privateCloud: true } };

/** The step's mount-time scope probe (`GET …/scope`) gets `scope`; every other call gets `response`. */
function stubNetwork(response: { status: number; body: unknown }, scope: { status: number; body: unknown } = PRIVATE_CLOUD_ON): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const answer = String(input).endsWith("/scope") ? scope : response;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
}

async function run(response: { status: number; body: unknown }, scope = PRIVATE_CLOUD_ON): Promise<string> {
  stubNetwork(response, scope);
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
  expect(await run({ status: 200, body: { removed: 3, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 0 } })).toBe(OWN);
  expect(await run({ status: 200, body: { removed: 1, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 0 } })).toBe(OWN);
});

test("(2) own and shared: the shared ones are said to be only removed from the list", async () => {
  expect(await run({ status: 200, body: { removed: 4, deleting: 0, listOnly: 2, notDeleted: 0, privateCloudDeleted: 0 } })).toBe(`${OWN} ${SHARED}`);
  expect(await run({ status: 200, body: { removed: 2, deleting: 0, listOnly: 1, notDeleted: 0, privateCloudDeleted: 0 } })).toBe(`${OWN} ${SHARED}`);
});

test("(3) shared only: nothing is called deleted", async () => {
  const text = await run({ status: 200, body: { removed: 2, deleting: 0, listOnly: 2, notDeleted: 0, privateCloudDeleted: 0 } });
  expect(text).toBe(`You had no recordings, voice notes or uploads of your own to delete. ${SHARED}`);
});

test("(4) nothing to delete, and the feature being dark", async () => {
  expect(await run({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 0 } })).toBe("You have no recordings, voice notes or uploads to delete.");
  expect(await run({ status: 404, body: { error: "not_found" } })).toBe("You have no meeting recordings to delete.");
});

test("private cloud not used by the deployment (null): the step says nothing about voice notes or uploads; 0 still means checked", async () => {
  const unused = { deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null };
  expect(await run({ status: 200, body: { removed: 3, ...unused } })).toBe("Your meeting recordings are deleted, including the notetaker service's copies.");
  expect(await run({ status: 200, body: { removed: 0, ...unused } })).toBe("You have no meeting recordings to delete.");
  expect(await run({ status: 202, body: { removed: 2, ...unused, deleting: 1 } })).toBe("Your meeting recordings are being deleted. We keep trying until each one is gone.");
  expect(await run({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 0 } })).toBe("You have no recordings, voice notes or uploads to delete.");
});

test("an own entry the provider did not attribute to the account is not reported as deleted, shared, or missing", async () => {
  const only = await run({ status: 200, body: { removed: 1, deleting: 0, listOnly: 0, notDeleted: 1, privateCloudDeleted: 0 } });
  expect(only).toBe(NOT_DELETED);
  expect(only).not.toMatch(/\b(is|are) deleted\b/);
  expect(only).not.toContain("had no recordings");
  expect(await run({ status: 200, body: { removed: 4, deleting: 0, listOnly: 1, notDeleted: 1, privateCloudDeleted: 0 } })).toBe(`${OWN} ${NOT_DELETED} ${SHARED}`);
});

test("an own delete still pending, or the request failing, never says deleted", async () => {
  const pending = await run({ status: 202, body: { removed: 2, deleting: 1, listOnly: 0, notDeleted: 0, privateCloudDeleted: 0 } });
  expect(pending).toBe(STILL);
  expect(pending).not.toContain("Your meeting recordings, voice notes and uploads are deleted");
  expect(await run({ status: 202, body: { removed: 3, deleting: 1, listOnly: 2, notDeleted: 0, privateCloudDeleted: 0 } })).toBe(`${STILL} ${SHARED}`);
  const failed = await run({ status: 503, body: { error: "transcriber_unavailable", removed: 1, deleting: 0, listOnly: 0, notDeleted: 0, failed: 1 } });
  expect(failed).toBe(FAILED);
});

test("voice notes and uploads: deleted ones count even with no meeting recording, and a failed private cloud delete never says deleted", async () => {
  expect(await run({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 3 } })).toBe(OWN);
  // Meeting recordings are all gone but private cloud could not be confirmed: the backend answers 503, so the failure line shows.
  const failed = await run({ status: 503, body: { error: "transcriber_unavailable", removed: 2, deleting: 0, listOnly: 0, notDeleted: 0, failed: 0, privateCloudFailed: true } });
  expect(failed).toBe(FAILED);
  expect(failed).not.toMatch(/\b(is|are) deleted\b/);
});

test("a backend that cannot say which removals were real deletes, or that private cloud was checked (an older one), never yields a 'deleted' claim", async () => {
  for (const body of [{ removed: 3, deleting: 0 }, { removed: 3, deleting: 0, listOnly: 0, notDeleted: 0 }]) {
    const text = await run({ status: 200, body });
    expect(text).toBe(FAILED);
    expect(text).not.toMatch(/\b(is|are) deleted\b/);
  }
});

test("the intro says it deletes the user's own recordings, voice notes and uploads, not every recording they can see", async () => {
  stubNetwork({ status: 200, body: {} });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const { DeleteRecordingsStep } = await import("./DeleteRecordingsStep"); // after installDom, as above
    await act(async () => {
      root.render(<DeleteRecordingsStep backendUrl="https://api.example" sessionStore={{ getToken: () => "t", isExpired: () => false } as unknown as SessionStore} />);
    });
    expect(host.textContent).toContain("Before you delete your account, delete your recordings. This permanently deletes your meeting recordings, voice notes and uploads held by the notetaker service and TinyCloud Private Transcription, including their transcripts.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

const INTRO = "Before you delete your account, delete your recordings. This permanently deletes your meeting recordings, voice notes and uploads held by the notetaker service and TinyCloud Private Transcription, including their transcripts.";
const INTRO_MEETINGS_ONLY = "Before you delete your account, delete your recordings. This permanently deletes your meeting recordings and transcripts, including the notetaker service's copies.";
const FAILED_MEETINGS_ONLY = "We couldn't finish deleting your recordings. Some may still be there. Try again in a moment.";

async function introFor(scope: { status: number; body: unknown }): Promise<string> {
  stubNetwork({ status: 200, body: {} }, scope);
  const { DeleteRecordingsStep } = await import("./DeleteRecordingsStep");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<DeleteRecordingsStep backendUrl="https://api.example" sessionStore={{ getToken: () => "t", isExpired: () => false } as unknown as SessionStore} />);
    });
    return host.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test("TC-3166: the intro names voice notes and uploads only where the deployment keeps them", async () => {
  expect(await introFor({ status: 200, body: { privateCloud: true } })).toContain(INTRO);
  const without = await introFor({ status: 200, body: { privateCloud: false } });
  expect(without).toContain(INTRO_MEETINGS_ONLY);
  expect(without).not.toMatch(/voice notes|uploads|Private Transcription/);
  // Neither service on (the probe's 404): the same meeting-only wording.
  const dark = await introFor({ status: 404, body: { error: "not_found" } });
  expect(dark).toContain(INTRO_MEETINGS_ONLY);
  expect(dark).not.toMatch(/voice notes|uploads|Private Transcription/);
});

test("TC-3166: a probe that fails or is unreadable shows the full wording, the one production runs", async () => {
  expect(await introFor({ status: 503, body: { error: "x" } })).toContain(INTRO);
  expect(await introFor({ status: 200, body: {} })).toContain(INTRO);
  expect(await introFor({ status: 401, body: { error: "unauthorized" } })).toContain(INTRO);
});

test("TC-3166: no intro is shown until the backend has said what the deployment keeps, so it never changes under the reader", async () => {
  const gate = Promise.withResolvers<Response>();
  globalThis.fetch = (async () => gate.promise) as typeof fetch;
  const { DeleteRecordingsStep } = await import("./DeleteRecordingsStep");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<DeleteRecordingsStep backendUrl="https://api.example" sessionStore={{ getToken: () => "t", isExpired: () => false } as unknown as SessionStore} />);
    });
    expect(host.textContent).not.toContain("Before you delete your account");
    await act(async () => { gate.resolve(new Response(JSON.stringify({ privateCloud: false }), { status: 200 })); });
    expect(host.textContent).toContain(INTRO_MEETINGS_ONLY);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("TC-3166: without private cloud the failure line does not name voice notes or uploads; with it, it does", async () => {
  const failure = { status: 503, body: { error: "transcriber_unavailable", removed: 1, deleting: 0, listOnly: 0, notDeleted: 0, failed: 1, privateCloudFailed: false } };
  expect(await run(failure, { status: 200, body: { privateCloud: false } })).toBe(FAILED_MEETINGS_ONLY);
  expect(await run(failure, { status: 200, body: { privateCloud: true } })).toBe(FAILED);
});
