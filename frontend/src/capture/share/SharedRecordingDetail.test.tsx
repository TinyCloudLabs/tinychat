// TC-3195: a received share's access ends at its signed expiry. Just before it, the row counts down and the page reads
// the recording; from that instant on, the row says it ended and the page reads nothing and offers to remove it.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { parseRecordingDisplay } from "@/lib/nativeShares/display";
import { RECEIVED_SHARES_PREFIX, receivedShares, type ReceivedRecordingShare } from "@/lib/nativeShares/receivedShares";
import { shortDate } from "../library/formatters";
import { sharedRowMeta } from "./shareCopy";

// Opening the share's reader stands in for the activation; every other export is real.
const realSdk = { ...(await import("@/lib/nativeShares/sdk")) };
let readerOpens = 0;
mock.module("@/lib/nativeShares/sdk", () => ({
  ...realSdk,
  openSharedKv: async () => {
    readerOpens++;
    return { get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "KV_NOT_FOUND" } }) };
  },
}));
afterAll(() => {
  mock.module("@/lib/nativeShares/sdk", () => realSdk);
});
const { SharedRecordingDetail } = await import("./SharedRecordingDetail");

const OWNER = "0xd5590000000000000000000000000000000ff412";
const END = new Date("2026-12-17T09:00:00.000Z");
const JUST_BEFORE = new Date(END.getTime() - 1);
const RECORD: ReceivedRecordingShare = {
  version: 1,
  id: "bafyroot",
  linkId: "7f3kq9x2m4hz8a1c5vd0wnbe6y",
  display: parseRecordingDisplay({ title: "Customer call: Northwind", recordedAt: "2026-11-16T15:00:00.000Z", durationSeconds: 900, includes: ["transcript"], source: "meeting" })!,
  owner: { address: OWNER, chainId: 1, spaceId: `tinycloud:pkh:eip155:1:${OWNER}:default` },
  delegation: "{}",
  paths: ["xyz.tinycloud.tinychat/connectors/fireflies/transcript/ff-1"],
  claimedAt: "2026-11-17T10:00:00.000Z",
  accessExpiresAt: END.toISOString(),
};

let accounts = 0;
/** A signed-in account whose space holds RECORD. */
function account(): TinyCloudWeb {
  const space = new Map<string, string>([[`${RECEIVED_SHARES_PREFIX}${RECORD.id}`, JSON.stringify(RECORD)]]);
  accounts++;
  return {
    did: `did:pkh:eip155:1:0x${String(accounts).padStart(40, "0")}`,
    kv: {
      list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...space.keys()].filter((key) => key.startsWith(path)) } }),
      get: async (key: string) => space.has(key) ? { ok: true, data: { data: space.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found" } },
      put: async (key: string, value: string) => ({ ok: true, data: space.set(key, value) && undefined }),
      delete: async (key: string) => ({ ok: true, data: space.delete(key) && undefined }),
    },
  } as unknown as TinyCloudWeb;
}

let restoreDom: (() => void) | undefined;
let root: Root | null = null;
beforeEach(() => {
  restoreDom = installDom();
  readerOpens = 0;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  await receivedShares.bind(null);
  restoreDom?.();
});

async function mount(now: Date): Promise<HTMLElement> {
  const tcw = account();
  await receivedShares.bind(tcw);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter><SharedRecordingDetail tcw={tcw} recordId={RECORD.id} pushed={false} onBack={() => {}} now={() => now} /></MemoryRouter>);
  });
  return container;
}

describe("a received share at the end of its access", () => {
  test("its row says Ends just before the end, and Ended from the end on", () => {
    const ends = (word: string, now: Date) => `From 0xd559…f412 · ${`${word} ${shortDate(END, now)}`.replaceAll(" ", "\u00a0")}`;
    expect(sharedRowMeta(RECORD, JUST_BEFORE)).toBe(ends("Ends", JUST_BEFORE));
    expect(sharedRowMeta(RECORD, END)).toBe(ends("Ended", END));
  });

  test("its page reads the recording just before the end; from the end on it reads nothing and offers to remove it", async () => {
    let page = await mount(JUST_BEFORE);
    expect(page.querySelector("[data-testid=shared-detail]")).not.toBeNull();
    expect(page.querySelector("[data-testid=shared-ended]")).toBeNull();
    expect(readerOpens).toBe(1);

    await act(async () => root!.unmount());
    readerOpens = 0;
    page = await mount(END);
    const ended = page.querySelector("[data-testid=shared-ended]");
    expect(ended?.textContent).toContain(`Your access to this recording ended on ${shortDate(END, END)}`);
    expect(ended?.textContent).toContain("Ask 0xd559…f412 to share it again if you need it.");
    expect([...page.querySelectorAll("button")].some((button) => button.textContent === "Remove from Library")).toBe(true);
    expect(page.querySelector("[data-testid=sender-address]")?.textContent).toContain(OWNER);
    expect(page.querySelector("[data-testid=shared-detail]")).toBeNull();
    expect(readerOpens).toBe(0);
  });
});
