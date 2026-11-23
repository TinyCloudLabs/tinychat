import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { clearPurgeLedgersForAccountDeletion } from "@/lib/connectors/accountLedgerClear";
import type { ConnectorWebhooksResult } from "@/lib/connectors/webhooksApi";

// Account deletion stops what could still deliver or import for the owner, then erases the deleted-meeting
// record (`DELETE /purged`) for every source, all before OpenKey's page opens: that page ends the session the
// routes need. Real component and client, faked network.

const SENTINEL = "sentinel-session-token-9c41e7b2";
const API = "https://api.example";
const PURGED = `DELETE ${API}/api/connectors/webhooks/purged`;
const DISABLE = `DELETE ${API}/api/connectors/webhooks/config`;
const GRANT = `DELETE ${API}/api/connectors/fireflies/delegation`;
const DELEGATION = `DELETE ${API}/api/delegations`;
const EXO = `DELETE ${API}/api/exo/v1/grant`;
const DISCONNECT = `POST ${API}/api/connectors/google/autojoin/disconnect`;
const CREDS = `${API}/api/connectors/credentials/fireflies`;
const CLEAR_FAILED = "We couldn't confirm the record of your deleted meetings was erased from our server. It may stay there. Try again, or continue to OpenKey.";
const FENCE_FAILED = "We couldn't stop our server from delivering or importing meetings for your account, so we did not erase the record of your deleted meetings. That record may stay on our server. Try again, or continue to OpenKey.";
const CALENDAR_FAILED = "We couldn't confirm Calendar autojoin was stopped or that your Google sign-in was removed from our server. Try again, or continue and remove TinyChat under connected apps in your Google account.";
const GOOGLE_UNCONFIRMED = "Calendar autojoin was stopped and your Google sign-in was removed from our server, but Google didn't confirm it revoked access. To be sure, remove TinyChat under connected apps in your Google account.";
const UNAVAILABLE = "The server is temporarily unavailable (503).";

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

let cleanDom: (() => void) | undefined;
const realFetch = globalThis.fetch;
const spies: Array<{ mockRestore: () => void }> = [];
let calls: string[];
/** The body of each `DELETE /purged`, parsed, in order. */
let purgedBodies: unknown[];
/** The body of each `POST /disconnect`, parsed, in order. */
let disconnectBodies: unknown[];
/** Answers per route, consumed in order; the last one repeats. */
let answers: Record<string, Answer[]>;
let opens: number;
/** `opens` at the time each `DELETE /purged` arrived. */
let opensAtClear: number[];

beforeAll(() => { cleanDom = installDom(); });
afterAll(() => { cleanDom?.(); });
beforeEach(() => {
  calls = [];
  purgedBodies = [];
  disconnectBodies = [];
  opens = 0;
  opensAtClear = [];
  answers = {
    // The Fireflies sign-in route is not mounted unless a test says otherwise.
    [`GET ${CREDS}`]: [{ status: 404, headers: { "X-Route-Unavailable": "connector-credentials" } }],
    [DISCONNECT]: [{ status: 200, body: { upstreamRevoked: "not_applicable" } }],
    [DISABLE]: [{ status: 200, body: { status: "disabled", queueDropped: 0 } }],
    [GRANT]: [{ status: 200, body: { state: "none", expiresAt: null } }],
    [DELEGATION]: [{ status: 200, body: { status: "none", expiresAt: null } }],
    [EXO]: [{ status: 200, body: { status: "none", expiresAt: null } }],
    [PURGED]: [{ status: 204 }],
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    spies.push(spyOn(console, level).mockImplementation(() => {}));
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    if (key === `DELETE ${API}/api/transcriber/meetings`) {
      return Response.json({ removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null });
    }
    if (key === DISCONNECT) disconnectBodies.push(JSON.parse(String(init?.body)));
    if (key === PURGED) {
      purgedBodies.push(JSON.parse(String(init?.body)));
      opensAtClear.push(opens);
    }
    const queue = answers[key];
    if (!queue) throw new Error(`no answer for ${key}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length > 0) spies.pop()!.mockRestore();
});

async function mount() {
  // Dynamic: the component must load after `installDom()` has run in `beforeAll`, as in the sibling test.
  const { DeleteOpenKeyAccountButton } = await import("./DeleteOpenKeyAccountButton");
  const sessionStore = { getToken: () => SENTINEL, isExpired: () => false } as unknown as SessionStore;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DeleteOpenKeyAccountButton backendUrl={API} sessionStore={sessionStore} openDeletionPage={async () => { opens += 1; }} />);
  });
  return {
    host,
    alert: () => host.querySelector("[role=alert]")?.textContent ?? null,
    buttons: () => [...host.querySelectorAll("button")].map((b) => b.textContent),
    click: async (label: string) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button).toBeDefined();
      await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

const FIREFLIES = { source: "fireflies" };
const GRANOLA = { source: "granola" };

test("each source's record is cleared with its own source in the body, before OpenKey opens", async () => {
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  expect(opensAtClear).toEqual([0, 0]);
  expect(opens).toBe(1);
  expect(page.alert()).toBeNull();
  await page.unmount();
});

test("delivery and import are stopped before any record is cleared, then OpenKey opens", async () => {
  answers[`GET ${CREDS}`] = [{ status: 200, body: { connected: true } }];
  answers[`DELETE ${CREDS}`] = [{ status: 200, body: { deleted: true, upstreamRevoked: true } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).toEqual([DISCONNECT, `DELETE ${API}/api/transcriber/meetings`, `GET ${CREDS}`, `DELETE ${CREDS}`, DISABLE, GRANT, DELEGATION, EXO, PURGED, PURGED]);
  expect(opens).toBe(1);
  await page.unmount();
});

test("if delivery cannot be stopped nothing is cleared, the alert says the record may stay, and Try again retries the whole step", async () => {
  answers[DISABLE] = [{ status: 503, body: { error: "unavailable" } }, { status: 200, body: { status: "disabled", queueDropped: 0 } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${FENCE_FAILED}`);
  expect(page.buttons()).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
  expect(purgedBodies).toEqual([]);
  expect(opens).toBe(0);
  await page.click("Try again");
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  expect(opens).toBe(1);
  await page.unmount();
});

test("if the server import grant cannot be removed nothing is cleared", async () => {
  answers[GRANT] = [{ status: 503, body: { error: "unavailable" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${FENCE_FAILED}`);
  expect(purgedBodies).toEqual([]);
  expect(opens).toBe(0);
  await page.click("Continue to OpenKey");
  expect(opens).toBe(1);
  expect(purgedBodies).toEqual([]);
  await page.unmount();
});

test("the connector grant and the exo grant are removed with the stop, and a failure on either clears nothing", async () => {
  answers[DELEGATION] = [{ status: 503, body: { error: "unavailable" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${FENCE_FAILED}`);
  // Every stop is still attempted, so one retry has less left to do.
  expect(calls).toEqual(expect.arrayContaining([DISABLE, GRANT, DELEGATION, EXO]));
  expect(purgedBodies).toEqual([]);
  expect(opens).toBe(0);
  await page.unmount();
});

test("an exo grant route that is not mounted is nothing to do", async () => {
  answers[EXO] = [{ status: 404 }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBeNull();
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  expect(opens).toBe(1);
  await page.unmount();
});

test("Calendar autojoin is disconnected first with an empty body, ahead of the recordings", async () => {
  answers[DISCONNECT] = [{ status: 200, body: { upstreamRevoked: "ok" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(disconnectBodies).toEqual([{}]);
  expect(calls.slice(0, 2)).toEqual([DISCONNECT, `DELETE ${API}/api/transcriber/meetings`]);
  expect(page.alert()).toBeNull();
  expect(opens).toBe(1);
  await page.unmount();
});

test("Google not confirming the revoke (502) is disclosed without claiming it was revoked; Continue carries on to the rest", async () => {
  answers[DISCONNECT] = [{ status: 502, body: { upstreamRevoked: "failed" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(GOOGLE_UNCONFIRMED);
  expect(page.buttons()).toEqual(["Continue to OpenKey"]);
  expect(calls).not.toContain(`DELETE ${API}/api/transcriber/meetings`);
  expect(opens).toBe(0);
  await page.click("Continue to OpenKey");
  expect(calls.filter((c) => c === DISCONNECT)).toHaveLength(1);
  expect(calls).toContain(`DELETE ${API}/api/transcriber/meetings`);
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  expect(opens).toBe(1);
  await page.unmount();
});

test("a failed Calendar disconnect shows the alert before anything is deleted; Try again repeats it, Continue moves on", async () => {
  answers[DISCONNECT] = [{ status: 503, body: { error: "unavailable" } }, { status: 200, body: { upstreamRevoked: "ok" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${CALENDAR_FAILED}`);
  expect(page.buttons()).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
  expect(calls).toEqual([DISCONNECT]);
  await page.click("Try again");
  expect(calls.filter((c) => c === DISCONNECT)).toHaveLength(2);
  expect(opens).toBe(1);
  await page.unmount();
});

test("continuing past a failed Calendar disconnect does not disconnect again", async () => {
  answers[DISCONNECT] = [{ status: 503, body: { error: "unavailable" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  await page.click("Continue to OpenKey");
  expect(calls.filter((c) => c === DISCONNECT)).toHaveLength(1);
  expect(opens).toBe(1);
  await page.unmount();
});

test("a failed clear shows the alert and keeps OpenKey closed; Try again clears again, then OpenKey opens", async () => {
  answers[PURGED] = [{ status: 503, body: { error: "unavailable" } }, { status: 204 }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${CLEAR_FAILED}`);
  expect(page.buttons()).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
  expect(opens).toBe(0);
  await page.click("Try again");
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA, FIREFLIES, GRANOLA]);
  expect(opens).toBe(1);
  expect(page.alert()).toBeNull();
  await page.unmount();
});

test("after a failed clear the owner can continue to OpenKey without clearing again", async () => {
  answers[PURGED] = [{ status: 503, body: { error: "unavailable" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(opens).toBe(0);
  await page.click("Continue to OpenKey");
  expect(opens).toBe(1);
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  await page.unmount();
});

test("one source failing does not stop the other from being cleared", async () => {
  // fireflies is first and fails; granola must still be cleared in the same pass.
  answers[PURGED] = [{ status: 503, body: { error: "unavailable" } }, { status: 204 }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  expect(page.alert()).toContain(CLEAR_FAILED);
  expect(opens).toBe(0);
  await page.unmount();
});

test("a Fireflies sign-in notice does not skip the records: continuing clears them, then opens OpenKey", async () => {
  answers[`GET ${CREDS}`] = [{ status: 200, body: { connected: true } }];
  answers[`DELETE ${CREDS}`] = [{ status: 502, body: { error: "upstream_revoke_failed", deleted: true } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(purgedBodies).toEqual([]);
  expect(opens).toBe(0);
  await page.click("Continue to OpenKey");
  expect(purgedBodies).toEqual([FIREFLIES, GRANOLA]);
  expect(opensAtClear).toEqual([0, 0]);
  expect(opens).toBe(1);
  await page.unmount();
});

test("a failed sign-in teardown stops before anything is stopped or cleared", async () => {
  answers[`GET ${CREDS}`] = [{ status: 200, body: { connected: true } }];
  answers[`DELETE ${CREDS}`] = [{ status: 503, body: { error: "revoke_failed" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).not.toContain(DISABLE);
  expect(purgedBodies).toEqual([]);
  expect(opens).toBe(0);
  await page.unmount();
});

test("routes not mounted: nothing to stop or clear, no alert, OpenKey opens", async () => {
  answers[DISCONNECT] = [{ status: 404 }];
  answers[DISABLE] = [{ status: 404 }];
  answers[GRANT] = [{ status: 404 }];
  answers[DELEGATION] = [{ status: 404 }];
  answers[EXO] = [{ status: 404 }];
  answers[PURGED] = [{ status: 404 }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBeNull();
  expect(opens).toBe(1);
  await page.unmount();
});

test("an unreachable server is a failure, never a silent skip, and the session token is not shown", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (`${init?.method ?? "GET"} ${String(input)}` === PURGED) throw new Error(`down Bearer ${SENTINEL}`);
    return real(input, init);
  }) as typeof fetch;
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toContain("Couldn't reach the server.");
  expect(page.alert()).toContain(CLEAR_FAILED);
  expect(page.host.textContent).not.toContain(SENTINEL);
  expect(opens).toBe(0);
  await page.unmount();
});

test("clearPurgeLedgersForAccountDeletion attempts every source and reports the first failure", async () => {
  const seen: string[] = [];
  const results: Record<string, ConnectorWebhooksResult<null>> = {
    a: { status: "ok", value: null },
    b: { status: "retryable", httpStatus: 503, code: null },
    c: { status: "offline" },
    d: { status: "feature-dark" },
  };
  const outcome = await clearPurgeLedgersForAccountDeletion(
    {
      disable: async () => ({ status: "ok", value: { status: "disabled", queueDropped: 0 } }),
      clearPurgeLedger: async (source) => { seen.push(source); return results[source]!; },
    },
    ["a", "b", "c", "d"],
  );
  expect(seen).toEqual(["a", "b", "c", "d"]);
  expect(outcome).toEqual({ status: "failed", step: "clear", failure: { status: "retryable", httpStatus: 503, code: null } });
});

test("a failed stop clears nothing", async () => {
  const seen: string[] = [];
  const outcome = await clearPurgeLedgersForAccountDeletion(
    {
      disable: async () => ({ status: "offline" }),
      clearPurgeLedger: async (source) => { seen.push(source); return { status: "ok", value: null }; },
    },
    ["a"],
  );
  expect(seen).toEqual([]);
  expect(outcome).toEqual({ status: "failed", step: "fence", failure: { status: "offline" } });
});
