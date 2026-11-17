// TC-3195: opening a share link adds nothing by itself. A signed-in account sees who shared what and adds it with
// "Add to Library"; signed out, "Sign in to open" is the request, and the share is added once sign-in finishes. A link
// is claimed once per account: opening it again opens the record it added, and nothing is claimed while the
// account's records cannot be read.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { receivedShares, sharedNoteId } from "@/lib/nativeShares/receivedShares";
import { notePath } from "@/shell/routes";
import type { OpenedShareLink } from "@/lib/nativeShares/sdk";

const OWNER = "0xd5590000000000000000000000000000000ff412";
const LINK: OpenedShareLink = {
  kind: "recording",
  display: { title: "Customer call: Northwind", recordedAt: "2026-11-16T15:00:00.000Z", durationSeconds: 900, includes: ["transcript"], source: "meeting" },
  token: "tc1:token",
  linkExpiresAt: "2026-12-16T15:00:00.000Z",
  owner: { address: OWNER, chainId: 1, spaceId: `tinycloud:pkh:eip155:1:${OWNER}:default` },
  accessExpiresAt: "2027-11-16T15:00:00.000Z",
};
const CLAIMED = { ok: true, share: { delegation: "{}", rootCid: "bafyroot", paths: ["xyz.tinycloud.tinychat/t/1"], accessExpiresAt: LINK.accessExpiresAt } };

// The link reader and the claim stand in for the network; every other export is real. The modules are imported
// dynamically so the stand-ins are registered before the surface loads them.
const realSdk = { ...(await import("@/lib/nativeShares/sdk")) };
const realLink = { ...(await import("@/lib/nativeShares/link")) };
const claims: string[] = [];
let claimResult: unknown = { ok: false, reason: "failed" };
mock.module("@/lib/nativeShares/sdk", () => ({
  ...realSdk,
  openShareLink: async () => LINK,
  claimShare: async (_tcw: TinyCloudWeb, token: string) => {
    claims.push(token);
    return claimResult;
  },
}));
mock.module("@/lib/nativeShares/link", () => ({ ...realLink, heldShareLink: () => "https://tinycloud.one/s/abc#k=1" }));
afterAll(() => {
  mock.module("@/lib/nativeShares/sdk", () => realSdk);
  mock.module("@/lib/nativeShares/link", () => realLink);
});
const { ShareLinkSurface } = await import("./ShareLinkSurface");
let accounts = 0;

/** A signed-in account whose space is a map; `listFails` makes its records unreadable. */
function account(options: { listFails?: boolean } = {}) {
  const space = new Map<string, string>();
  const kv = {
    list: async ({ path }: { path: string }) => options.listFails
      ? { ok: false, error: { code: "NETWORK_ERROR", message: "offline" } }
      : { ok: true, data: { keys: [...space.keys()].filter((key) => key.startsWith(path)) } },
    get: async (key: string) => (space.has(key) ? { ok: true, data: { data: space.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "x" } }),
    put: async (key: string, value: string) => {
      space.set(key, value);
      return { ok: true, data: undefined };
    },
  };
  accounts++;
  return { tcw: { did: `did:pkh:eip155:1:0x${String(accounts).padStart(40, "0")}`, kv } as unknown as TinyCloudWeb, space };
}

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let at = "";
beforeEach(() => {
  restoreDom = installDom();
  claims.length = 0;
  claimResult = { ok: false, reason: "failed" };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  await receivedShares.bind(null);
  restoreDom?.();
});

function Location() {
  at = useLocation().pathname;
  return null;
}

async function mount(tcw: TinyCloudWeb | null, onSignIn: () => void = () => {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (next: TinyCloudWeb | null) => act(async () => {
    root!.render(<MemoryRouter initialEntries={["/s/abc"]}><ShareLinkSurface tcw={next} state={next ? "ready" : "unauthenticated"} error={null} onSignIn={onSignIn} /><Location /></MemoryRouter>);
  });
  await render(tcw);
  return { container, render };
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === label);
}

async function tap(container: HTMLElement, label: string) {
  await act(async () => button(container, label)!.click());
}

describe("ShareLinkSurface", () => {
  test("a signed-in account adds the share only when it taps Add to Library", async () => {
    const { container } = await mount(account().tcw);
    expect(container.textContent).toContain("0xd559…f412 shared a recording with you");
    expect(claims).toEqual([]);
    await tap(container, "Add to Library");
    expect(claims).toEqual(["tc1:token"]);
  });

  test("signed out, Sign in to open is the request: the share is added once sign-in finishes", async () => {
    let signIns = 0;
    const { container, render } = await mount(null, () => signIns++);
    expect(button(container, "Add to Library")).toBeUndefined();
    await tap(container, "Sign in to open");
    expect(signIns).toBe(1);
    expect(claims).toEqual([]);
    await render(account().tcw);
    expect(claims).toEqual(["tc1:token"]);
  });

  test("signing in some other way does not add it", async () => {
    const { container, render } = await mount(null);
    await render(account().tcw);
    expect(claims).toEqual([]);
    expect(button(container, "Add to Library")).toBeDefined();
  });

  test("a link the account already added opens its record and is never claimed again", async () => {
    claimResult = CLAIMED;
    const { tcw, space } = account();
    let view = await mount(tcw);
    await tap(view.container, "Add to Library");
    expect(claims).toEqual(["tc1:token"]);
    expect(at).toBe(notePath(sharedNoteId("bafyroot")));
    expect([...space.values()].map((value) => JSON.parse(value).linkId)).toEqual(["abc"]);

    // The same link again, in a later session: the records come from the space.
    await act(async () => root!.unmount());
    await receivedShares.bind(null);
    view = await mount(tcw);
    await tap(view.container, "Add to Library");
    expect(claims).toEqual(["tc1:token"]);
    expect(at).toBe(notePath(sharedNoteId("bafyroot")));
  });

  test("when the account's records cannot be read, nothing is claimed", async () => {
    claimResult = CLAIMED;
    const { container } = await mount(account({ listFails: true }).tcw);
    await tap(container, "Add to Library");
    expect(claims).toEqual([]);
    expect(container.querySelector("[data-problem]")?.getAttribute("data-problem")).toBe("claim-failed");
  });
});
