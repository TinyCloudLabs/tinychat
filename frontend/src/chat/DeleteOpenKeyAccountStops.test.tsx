import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import type * as TranscriptDelegationModule from "@/lib/transcriptDelegation";
import { clearTranscriptDelegationSchedule, retireTranscriptDelegation } from "@/lib/transcriptDelegation";
import { stopServerAccessForAccountDeletion } from "@/lib/connectors/accountServerStops";
import type { ConnectorWebhooksResult } from "@/lib/connectors/webhooksApi";

// Account deletion stops what our server could still do for the owner (delivery, the import grant, the connector
// grant, the exo grant), keeps every open tab from writing the transcript grant again, signs this device out and
// then opens OpenKey. It never clears the record of deleted meetings. Real component and client, faked network.

const SENTINEL = "sentinel-session-token-9c41e7b2";
const API = "https://api.example";
const ADDRESS = "0x0000000000000000000000000000000000000abc";
const DISABLE = `DELETE ${API}/api/connectors/webhooks/config`;
const GRANT = `DELETE ${API}/api/connectors/fireflies/delegation`;
const DELEGATION = `DELETE ${API}/api/delegations`;
const EXO = `DELETE ${API}/api/exo/v1/grant`;
const DISCONNECT = `POST ${API}/api/connectors/google/autojoin/disconnect`;
const MEETINGS = `DELETE ${API}/api/transcriber/meetings`;
const CREDS = `${API}/api/connectors/credentials/fireflies`;
const TABS_NOT_STOPPED = "We couldn't stop this browser's other open tabs from writing to your space again, so a tab left open may restore access we removed. Try again, or close the other tabs and continue to OpenKey.";
const GRANT_STATUS = `GET ${API}/api/delegations/status`;
const SERVER_INFO = `GET ${API}/api/server-info`;
const GRANT_POST = `POST ${API}/api/delegations`;
const STOP_FAILED = "We couldn't confirm that our server stopped delivering and importing meetings for your account. Try again, or continue to OpenKey.";
const CALENDAR_FAILED = "We couldn't confirm that Calendar autojoin stopped or that your Google sign-in was removed from our server. Try again, or continue and remove our app's access in your Google account.";
const GOOGLE_UNCONFIRMED = "Calendar autojoin stopped and your Google sign-in was removed from our server, but Google didn't confirm it revoked access. To be sure, remove our app's access in your Google account.";
const GOOGLE_LINK = "Open your Google account";
const UNAVAILABLE = "The server is temporarily unavailable (503).";
const DAY = 86_400_000;

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => { rows.delete(key); },
    setItem: (key, value) => { rows.set(key, value); },
  };
}

let cleanDom: (() => void) | undefined;
const realFetch = globalThis.fetch;
const spies: Array<{ mockRestore: () => void }> = [];
let calls: string[];
/** The body of each `POST /disconnect`, parsed, in order. */
let disconnectBodies: unknown[];
/** Answers per route, consumed in order; the last one repeats. */
let answers: Record<string, Answer[]>;
/** `open` and `signOut` in the order they happened. */
let events: string[];
/** Runs when the named route is requested, before it is answered. */
let hooks: Record<string, () => Promise<void>>;
let storage: Storage;

beforeAll(() => {
  storage = memoryStorage();
  cleanDom = installDom({ localStorage: storage });
});
afterAll(() => { cleanDom?.(); });
beforeEach(() => {
  storage.clear();
  calls = [];
  disconnectBodies = [];
  events = [];
  hooks = {};
  answers = {
    // The Fireflies sign-in route is not mounted unless a test says otherwise.
    [`GET ${CREDS}`]: [{ status: 404, headers: { "X-Route-Unavailable": "connector-credentials" } }],
    [DISCONNECT]: [{ status: 200, body: { upstreamRevoked: "not_applicable" } }],
    [DISABLE]: [{ status: 200, body: { status: "disabled", queueDropped: 0 } }],
    [GRANT]: [{ status: 200, body: { state: "none", expiresAt: null } }],
    [DELEGATION]: [{ status: 200, body: { status: "none", expiresAt: null } }],
    [EXO]: [{ status: 200, body: { status: "none", expiresAt: null } }],
    [GRANT_STATUS]: [{ status: 200, body: { status: "none", expiresAt: null, verified: false, delivery: "enabled" } }],
    [SERVER_INFO]: [{ status: 200, body: { did: `did:pkh:eip155:1:${ADDRESS}` } }],
    [GRANT_POST]: [{ status: 200, body: { status: "active", verified: true, delivery: "enabled", expiresAt: null } }],
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    spies.push(spyOn(console, level).mockImplementation(() => {}));
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(key);
    if (key === MEETINGS) {
      return Response.json({ removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null });
    }
    if (key === DISCONNECT) disconnectBodies.push(JSON.parse(String(init?.body)));
    await hooks[key]?.();
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

async function mount(sessionStore: SessionStore = { getToken: () => SENTINEL, isExpired: () => false } as unknown as SessionStore) {
  // Dynamic: the component must load after `installDom()` has run in `beforeAll`, as in the sibling test.
  const { DeleteOpenKeyAccountButton } = await import("./DeleteOpenKeyAccountButton");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <DeleteOpenKeyAccountButton
        backendUrl={API}
        sessionStore={sessionStore}
        openDeletionPage={async () => { events.push("open"); }}
        onSignOut={() => { events.push("signOut"); }}
      />,
    );
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

test("every stop runs in order, then this device signs out, then OpenKey opens; no record is cleared", async () => {
  answers[`GET ${CREDS}`] = [{ status: 200, body: { connected: true } }];
  answers[`DELETE ${CREDS}`] = [{ status: 200, body: { deleted: true, upstreamRevoked: true } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).toEqual([DISCONNECT, MEETINGS, `GET ${CREDS}`, `DELETE ${CREDS}`, DISABLE, GRANT, DELEGATION, EXO]);
  expect(calls.some((call) => call.includes("/webhooks/purged"))).toBe(false);
  expect(events).toEqual(["signOut", "open"]);
  expect(page.alert()).toBeNull();
  await page.unmount();
});

test("if a stop cannot be confirmed OpenKey stays closed with Try again and Continue; every stop is still attempted", async () => {
  answers[DISABLE] = [{ status: 503, body: { error: "unavailable" } }, { status: 200, body: { status: "disabled", queueDropped: 0 } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${STOP_FAILED}`);
  expect(page.buttons()).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
  expect(calls.slice(-4)).toEqual([DISABLE, GRANT, DELEGATION, EXO]);
  expect(events).toEqual([]);
  await page.click("Try again");
  expect(calls.filter((call) => call === DISABLE)).toHaveLength(2);
  expect(events).toEqual(["signOut", "open"]);
  expect(page.alert()).toBeNull();
  await page.unmount();
});

test("each stop's failure is disclosed, and Continue signs out and opens OpenKey without stopping again", async () => {
  for (const route of [GRANT, DELEGATION, EXO]) {
    events = [];
    calls = [];
    answers[route] = [{ status: 503, body: { error: "unavailable" } }];
    const page = await mount();
    await page.click("Delete OpenKey account");
    expect(page.alert()).toBe(`${UNAVAILABLE} ${STOP_FAILED}`);
    expect(events).toEqual([]);
    await page.click("Continue to OpenKey");
    expect(events).toEqual(["signOut", "open"]);
    expect(calls.filter((call) => call === route)).toHaveLength(1);
    await page.unmount();
    answers[route] = [{ status: 200, body: {} }];
  }
});

test("an exo grant route that is not mounted is nothing to do", async () => {
  answers[EXO] = [{ status: 404 }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBeNull();
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("Calendar autojoin is disconnected first with an empty body, ahead of the recordings", async () => {
  answers[DISCONNECT] = [{ status: 200, body: { upstreamRevoked: "ok" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(disconnectBodies).toEqual([{}]);
  expect(calls.slice(0, 2)).toEqual([DISCONNECT, MEETINGS]);
  expect(page.alert()).toBeNull();
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("Google not confirming the revoke (502) is disclosed without claiming it was revoked; Continue carries on to the rest", async () => {
  answers[DISCONNECT] = [{ status: 502, body: { upstreamRevoked: "failed" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${GOOGLE_UNCONFIRMED} ${GOOGLE_LINK}`);
  // The link opens Google's page for managing third-party access in a new tab, without handing over the opener.
  const link = page.host.querySelector("[role=alert] a");
  expect(link?.getAttribute("href")).toBe("https://myaccount.google.com/connections");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(page.buttons()).toEqual(["Continue to OpenKey"]);
  expect(calls).not.toContain(MEETINGS);
  expect(events).toEqual([]);
  await page.click("Continue to OpenKey");
  expect(calls.filter((call) => call === DISCONNECT)).toHaveLength(1);
  expect(calls).toContain(MEETINGS);
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("a failed Calendar disconnect shows the alert before anything is deleted; Try again repeats it", async () => {
  answers[DISCONNECT] = [{ status: 503, body: { error: "unavailable" } }, { status: 200, body: { upstreamRevoked: "ok" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBe(`${UNAVAILABLE} ${CALENDAR_FAILED} ${GOOGLE_LINK}`);
  expect(page.buttons()).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
  expect(calls).toEqual([DISCONNECT]);
  await page.click("Try again");
  expect(calls.filter((call) => call === DISCONNECT)).toHaveLength(2);
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("continuing past a failed Calendar disconnect does not disconnect again", async () => {
  answers[DISCONNECT] = [{ status: 503, body: { error: "unavailable" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  await page.click("Continue to OpenKey");
  expect(calls.filter((call) => call === DISCONNECT)).toHaveLength(1);
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("a Fireflies sign-in notice does not skip the stops: continuing runs them, then signs out and opens OpenKey", async () => {
  answers[`GET ${CREDS}`] = [{ status: 200, body: { connected: true } }];
  answers[`DELETE ${CREDS}`] = [{ status: 502, body: { error: "upstream_revoke_failed", deleted: true } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).not.toContain(DISABLE);
  expect(events).toEqual([]);
  await page.click("Continue to OpenKey");
  expect(calls.slice(-4)).toEqual([DISABLE, GRANT, DELEGATION, EXO]);
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("a failed sign-in teardown stops before anything is stopped", async () => {
  answers[`GET ${CREDS}`] = [{ status: 200, body: { connected: true } }];
  answers[`DELETE ${CREDS}`] = [{ status: 503, body: { error: "revoke_failed" } }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(calls).not.toContain(DISABLE);
  expect(events).toEqual([]);
  await page.unmount();
});

test("routes not mounted: nothing to stop, no alert, then sign out and OpenKey opens", async () => {
  for (const route of [DISCONNECT, DISABLE, GRANT, DELEGATION, EXO]) answers[route] = [{ status: 404 }];
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toBeNull();
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});

test("an unreachable server is a failure, never a silent skip, and the session token is not shown", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (`${init?.method ?? "GET"} ${String(input)}` === DISABLE) throw new Error(`down Bearer ${SENTINEL}`);
    return real(input, init);
  }) as typeof fetch;
  const page = await mount();
  await page.click("Delete OpenKey account");
  expect(page.alert()).toContain("Couldn't reach the server.");
  expect(page.alert()).toContain(STOP_FAILED);
  expect(page.host.textContent).not.toContain(SENTINEL);
  expect(events).toEqual([]);
  await page.unmount();
});

test("stopServerAccessForAccountDeletion attempts every stop and reports the first failure", async () => {
  const seen: string[] = [];
  const stop = (name: string, result: ConnectorWebhooksResult<never> | ConnectorWebhooksResult<{ state: string }> | ConnectorWebhooksResult<{ status: string }>) =>
    async () => { seen.push(name); return result as never; };
  const outcome = await stopServerAccessForAccountDeletion({
    disable: stop("disable", { status: "ok", value: { status: "disabled", queueDropped: 0 } } as never),
    removeFirefliesImportGrant: stop("grant", { status: "retryable", httpStatus: 503, code: null }),
    removeBackendDelegation: stop("delegation", { status: "offline" }),
    removeExoGrant: stop("exo", { status: "feature-dark" }),
  });
  expect(seen).toEqual(["disable", "grant", "delegation", "exo"]);
  expect(outcome).toEqual({ status: "failed", failure: { status: "retryable", httpStatus: 503, code: null } });
});

// A second tab holds the same sign-in and re-checks the transcript grant on focus. Tab B is a second copy of the
// module (its own memory) over the same `localStorage`, with its own SessionStore, as a real second tab is.
interface TabBFake {
  operations: string[];
  /** While set, minting the grant waits for it. */
  control: { gate: Promise<void> | null };
  tcw: TinyCloudWeb;
}

function tabBFake(): TabBFake {
  const operations: string[] = [];
  const control: TabBFake["control"] = { gate: null };
  const db = {
    query: async () => ({ ok: true, data: { rows: [["connector_state"], ["connector_meeting"]] } }),
    execute: async () => { throw new Error("The schema already exists"); },
  };
  const tcw = {
    address: () => ADDRESS, chainId: () => 1, hosts: ["https://node.tinycloud.xyz"],
    session: () => ({ siwe: `Expiration Time: ${new Date(Date.now() + 30 * DAY).toISOString()}`, signature: "0xsigned", chainId: 1 }),
    sql: { db: () => db },
    delegateTo: async () => {
      operations.push("delegateTo");
      await control.gate;
      return { prompted: false, delegation: {
        cid: "bafy-transcript-test", delegationHeader: { Authorization: "Bearer eyJhbGciOiJFZERTQSJ9.eyJhdHQiOnt9fQ.signature" },
        spaceId: `did:pkh:eip155:1:${ADDRESS}:applications`, path: "xyz.tinycloud.tinychat/connectors",
        actions: ["tinycloud.sql/read", "tinycloud.sql/write"], resources: [],
        expiry: new Date(Date.now() + 29 * DAY), delegateDID: `did:pkh:eip155:1:${ADDRESS}`,
      } };
    },
  } as unknown as TinyCloudWeb;
  return { operations, control, tcw };
}

interface SecondTab {
  /** Tab A's session store. */
  first: SessionStore;
  fake: TabBFake;
  /** What tab B does when it gains focus. */
  focus: () => Promise<string>;
  tabB: TranscriptDelegationModule;
}

/** Runs `run` with tab A's session store and a focus handler for tab B, which holds the same sign-in token. */
async function withSecondTab(token: string, run: (tabs: SecondTab) => Promise<void>) {
  const lockedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => Promise<unknown>) => action({}) } },
  });
  try {
    const first = new SessionStore();
    first.setSession(token, 3600, ADDRESS);
    const tabB: TranscriptDelegationModule = await import("../lib/transcriptDelegation.ts?second-tab");
    const second = new SessionStore();
    expect(second.getToken()).toBe(token);
    const fake = tabBFake();
    const focus = () => tabB.ensureTranscriptWriterDelegation({ tcw: fake.tcw, backendUrl: API, sessionStore: second });
    await run({ first, fake, focus, tabB });
  } finally {
    if (lockedNavigator) Object.defineProperty(globalThis, "navigator", lockedNavigator);
    // The consent state is module-wide and the suite shares one process: leave it as found.
    clearTranscriptDelegationSchedule(ADDRESS);
  }
}

async function until(condition: () => boolean) {
  for (let turn = 0; turn < 200 && !condition(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(condition()).toBe(true);
}

test("a second open tab does not write the transcript grant again once account deletion removed it", async () => {
  await withSecondTab("tab-a-sign-in", async ({ first, fake, focus, tabB }) => {
    // While deletion has not run the second tab writes the grant on focus: this is what must stop.
    expect(await focus()).toBe("active");
    expect(calls.filter((call) => call === GRANT_POST)).toHaveLength(1);

    const page = await mount(first);
    await page.click("Delete OpenKey account");
    expect(calls).toContain(DELEGATION);
    expect(events).toEqual(["signOut", "open"]);
    await page.unmount();

    // The server answers "no grant", as it does once the grant is removed. Focus, then focus again.
    expect(await focus()).toBe("disabled");
    expect(await focus()).toBe("disabled");
    expect(calls.filter((call) => call === GRANT_POST)).toHaveLength(1);
    expect(fake.operations.filter((operation) => operation === "delegateTo")).toHaveLength(1);

    // A new sign-in is a different token and is not held back.
    const fresh = new SessionStore();
    fresh.setSession("a-new-sign-in", 3600, ADDRESS);
    expect(await tabB.ensureTranscriptWriterDelegation({ tcw: fake.tcw, backendUrl: API, sessionStore: fresh })).toBe("active");
    expect(calls.filter((call) => call === GRANT_POST)).toHaveLength(2);
  });
});

test("a grant request already under way in another tab is not sent once the sign-in is retired", async () => {
  await withSecondTab("in-flight-sign-in", async ({ first, fake, focus }) => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    fake.control.gate = gate;
    // Tab B passes its first check and waits while the grant is being signed.
    const pending = focus();
    await until(() => fake.operations.includes("delegateTo"));
    await retireTranscriptDelegation(first);
    release();
    expect(await pending).toBe("disabled");
    expect(calls.filter((call) => call === GRANT_POST)).toHaveLength(0);
  });
});

test("every other tab is held back before the first stop is sent, so none can write the grant while it is removed", async () => {
  await withSecondTab("ordering-sign-in", async ({ first, focus }) => {
    const stops = [DISABLE, GRANT, DELEGATION, EXO];
    const focusDuring: string[] = [];
    for (const stop of stops) hooks[stop] = async () => { focusDuring.push(`${stop} ${await focus()}`); };
    const page = await mount(first);
    await page.click("Delete OpenKey account");
    expect(events).toEqual(["signOut", "open"]);
    await page.unmount();
    expect(focusDuring).toEqual(stops.map((stop) => `${stop} disabled`));
    expect(calls).not.toContain(GRANT_POST);
  });
});

test("a browser that cannot hash the sign-in token says other tabs are not covered; the stops still run, Try again repeats", async () => {
  const own = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
  // Plain http pages have no `crypto.subtle`.
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: undefined });
  const page = await mount();
  try {
    await page.click("Delete OpenKey account");
    expect(page.alert()).toBe(TABS_NOT_STOPPED);
    expect(page.buttons()).toEqual(expect.arrayContaining(["Try again", "Continue to OpenKey"]));
    expect(calls.slice(-4)).toEqual([DISABLE, GRANT, DELEGATION, EXO]);
    expect(events).toEqual([]);
  } finally {
    if (own) Object.defineProperty(globalThis.crypto, "subtle", own);
    else Reflect.deleteProperty(globalThis.crypto, "subtle");
  }
  await page.click("Try again");
  expect(page.alert()).toBeNull();
  expect(events).toEqual(["signOut", "open"]);
  await page.unmount();
});
