// TC-3195: opening a share link adds nothing by itself. A signed-in account sees who shared what and adds it with
// "Add to Library"; signed out, "Sign in to add" is the request, and the share is added once sign-in finishes. A share
// is claimed once per account, known by its signed root: opening it again, from any link, opens the record it added,
// and nothing is claimed while whether it was added cannot be read. The whole sender address is shown, marked when
// this Library has nothing else from it.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { parseRecordingDisplay } from "@/lib/nativeShares/display";
import { RECEIVED_SHARES_PREFIX, receivedShareRecord, receivedShares, sharedNoteId } from "@/lib/nativeShares/receivedShares";
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
  rootCid: "bafyroot",
};
const CLAIMED = { ok: true, share: { delegation: "{}", rootCid: "bafyroot", paths: ["xyz.tinycloud.tinychat/t/1"], accessExpiresAt: LINK.accessExpiresAt } };

// The link reader and the claim stand in for the network; every other export is real. The modules are imported
// dynamically so the stand-ins are registered before the surface loads them.
const realSdk = { ...(await import("@/lib/nativeShares/sdk")) };
const realLink = { ...(await import("@/lib/nativeShares/link")) };
const claims: string[] = [];
let sdkLink: OpenedShareLink = LINK;
let claimResult: unknown = { ok: false, reason: "failed" };
mock.module("@/lib/nativeShares/sdk", () => ({
  ...realSdk,
  openShareLink: async () => sdkLink,
  claimShare: async (_tcw: TinyCloudWeb, token: string) => {
    claims.push(token);
    return claimResult;
  },
}));
let held = "https://tinycloud.one/s/abc#k=1";
mock.module("@/lib/nativeShares/link", () => ({ ...realLink, heldShareLink: () => held }));
afterAll(() => {
  mock.module("@/lib/nativeShares/sdk", () => realSdk);
  mock.module("@/lib/nativeShares/link", () => realLink);
});
const { ShareLinkSurface } = await import("./ShareLinkSurface");
let accounts = 0;

/** A signed-in account whose space is a map; `getFails` answers every read with that error. */
function account(options: { getFails?: { code: string; message: string } } = {}) {
  const space = new Map<string, string>();
  const kv = {
    list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...space.keys()].filter((key) => key.startsWith(path)) } }),
    get: async (key: string) => options.getFails ? { ok: false, error: options.getFails }
      : space.has(key) ? { ok: true, data: { data: space.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found" } },
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
  held = "https://tinycloud.one/s/abc#k=1";
  sdkLink = LINK;
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

  test("signed out, Sign in to add is the request: the share is added once sign-in finishes", async () => {
    let signIns = 0;
    const { container, render } = await mount(null, () => signIns++);
    expect(button(container, "Add to Library")).toBeUndefined();
    await tap(container, "Sign in to add");
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

  test("a share the account already added opens its record from any link, unchanged, and is never claimed again", async () => {
    claimResult = CLAIMED;
    const { tcw, space } = account();
    let view = await mount(tcw);
    await tap(view.container, "Add to Library");
    expect(claims).toEqual(["tc1:token"]);
    expect(at).toBe(notePath(sharedNoteId("bafyroot")));
    const stored = [...space.values()];
    expect(stored.map((value) => JSON.parse(value).linkId)).toEqual(["abc"]);

    // The same share, in a later session, from another link (upper-case id, another title): the record opens as it was.
    await act(async () => root!.unmount());
    await receivedShares.bind(null);
    held = "https://tinycloud.one/s/OTHERLINK#k=1";
    sdkLink = { ...LINK, display: { ...LINK.display, title: "Something else" } };
    view = await mount(tcw);
    await tap(view.container, "Add to Library");
    expect(claims).toEqual(["tc1:token"]);
    expect(at).toBe(notePath(sharedNoteId("bafyroot")));
    expect([...space.values()]).toEqual(stored);
  });

  test("when whether the share was added cannot be read, nothing is claimed", async () => {
    claimResult = CLAIMED;
    const unreadable = account();
    unreadable.space.set(`${RECEIVED_SHARES_PREFIX}bafyroot`, "not a record");
    for (const tcw of [
      account({ getFails: { code: "NETWORK_ERROR", message: "offline" } }).tcw,
      account({ getFails: { code: "KV_NOT_FOUND", message: "Space not found" } }).tcw,
      unreadable.tcw,
    ]) {
      const { container } = await mount(tcw);
      await tap(container, "Add to Library");
      expect(claims).toEqual([]);
      expect(container.querySelector("[data-problem]")?.getAttribute("data-problem")).toBe("claim-failed");
      await act(async () => root!.unmount());
      root = null;
    }
  });

  test("shows the whole sender address, marked as a first share only when this Library has nothing from them", async () => {
    const full = OWNER; // all 42 characters (its EIP-55 form is all lower case)
    const first = account();
    await receivedShares.bind(first.tcw);
    let view = await mount(first.tcw);
    expect(view.container.querySelector("[data-testid=sender-address]")?.textContent).toContain(full);
    expect(view.container.querySelector("[data-testid=first-share]")?.textContent).toBe("First share from this sender");

    await act(async () => root!.unmount());
    const again = account();
    again.space.set(`${RECEIVED_SHARES_PREFIX}bafyearlier`, JSON.stringify(receivedShareRecord(LINK, parseRecordingDisplay(LINK.display)!, { ...CLAIMED.share, rootCid: "bafyearlier" }, new Date(), "earlier")));
    await receivedShares.bind(again.tcw);
    view = await mount(again.tcw);
    expect(view.container.querySelector("[data-testid=sender-address]")?.textContent).toContain(full);
    expect(view.container.querySelector("[data-testid=first-share]")).toBeNull();

    await act(async () => root!.unmount());
    await receivedShares.bind(null);
    view = await mount(null);
    expect(view.container.querySelector("[data-testid=sender-address]")?.textContent).toContain(full);
    expect(view.container.querySelector("[data-testid=first-share]")).toBeNull();
  });

  test("when the owner has stopped sharing, the page still shows the whole sender address", async () => {
    claimResult = { ok: false, reason: "revoked" };
    const { container } = await mount(account().tcw);
    await tap(container, "Add to Library");
    const revoked = container.querySelector("[data-testid=share-link-revoked]");
    expect(revoked?.textContent).toContain("0xd559…f412 stopped sharing this recording");
    expect(revoked?.querySelector("[data-testid=sender-address]")?.textContent).toContain(OWNER);
  });
});
