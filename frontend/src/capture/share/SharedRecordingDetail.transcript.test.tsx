// TC-3195: a recording someone shared with you shows its transcript. The share's reader returns the transcript stored
// in the owner's space; the page shows its text, with the speakers, and neither the "no transcript" nor the "couldn't
// load" state.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { parseRecordingDisplay } from "@/lib/nativeShares/display";
import { RECEIVED_SHARES_PREFIX, receivedShares, type ReceivedRecordingShare } from "@/lib/nativeShares/receivedShares";

const TRANSCRIPT_KEY = "xyz.tinycloud.tinychat/connectors/fireflies/transcript/ff-render";

// The share's reader stands in for the activation: it answers from the owner's stored transcript. Every other export is real.
const realSdk = { ...(await import("@/lib/nativeShares/sdk")) };
let stored: string | null = null;
let asked: string[] = [];
mock.module("@/lib/nativeShares/sdk", () => ({
  ...realSdk,
  openSharedKv: async () => ({
    get: async (key: string) => {
      asked.push(key);
      return key === TRANSCRIPT_KEY && stored !== null
        ? { ok: true, data: { data: stored } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "KV_NOT_FOUND" } };
    },
  }),
}));
afterAll(() => {
  mock.module("@/lib/nativeShares/sdk", () => realSdk);
});
const { SharedRecordingDetail } = await import("./SharedRecordingDetail");

const OWNER = "0xd5590000000000000000000000000000000ff412";
const NOW = new Date("2026-11-19T02:00:00.000Z");
const RECORD: ReceivedRecordingShare = {
  version: 1,
  id: "bafyrender",
  linkId: "4n8rt2wq7c1hz6k9m3vd5xbe0y",
  display: parseRecordingDisplay({ title: "Customer call: Northwind", recordedAt: "2026-11-16T15:00:00.000Z", durationSeconds: 900, includes: ["transcript"], source: "meeting" })!,
  owner: { address: OWNER, chainId: 1, spaceId: `tinycloud:pkh:eip155:1:${OWNER}:default` },
  delegation: "{}",
  paths: [TRANSCRIPT_KEY],
  claimedAt: "2026-11-17T10:00:00.000Z",
  accessExpiresAt: "2026-12-17T09:00:00.000Z",
};

const sentence = (index: number, speaker: string, text: string, start: number, end: number, timing?: FirefliesSentence["timing"]): FirefliesSentence =>
  ({ index, speaker_name: speaker, text, start_time: start, end_time: end, ...(timing ? { timing } : {}) });

let accounts = 0;
/** A signed-in account whose space holds RECORD. */
function account(): TinyCloudWeb {
  const space = new Map<string, string>([[`${RECEIVED_SHARES_PREFIX}${RECORD.id}`, JSON.stringify(RECORD)]]);
  accounts++;
  return {
    did: `did:pkh:eip155:1:0x7e${String(accounts).padStart(38, "0")}`,
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
  stored = null;
  asked = [];
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  await receivedShares.bind(null);
  restoreDom?.();
});

async function mount(): Promise<HTMLElement> {
  const tcw = account();
  await receivedShares.bind(tcw);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter><SharedRecordingDetail tcw={tcw} recordId={RECORD.id} pushed={false} onBack={() => {}} now={() => NOW} /></MemoryRouter>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

function expectShown(page: HTMLElement, texts: string[]) {
  const section = page.querySelector("[data-testid=note-transcript]");
  expect(section).not.toBeNull();
  for (const text of texts) expect(section!.textContent).toContain(text);
  expect(page.querySelector("[data-testid=note-transcript-absent]")).toBeNull();
  expect(page.querySelector("[data-testid=note-transcript-failed]")).toBeNull();
  expect(asked).toEqual([TRANSCRIPT_KEY]);
}

describe("a shared recording's transcript", () => {
  test("without times, its text shows under each speaker", async () => {
    stored = JSON.stringify([
      sentence(0, "Avery", "Thanks for joining, let's start with the renewal.", 0, 0, "unknown"),
      sentence(1, "Avery", "The quote went out on Friday.", 0, 0, "unknown"),
      sentence(2, "Jordan", "We signed it this morning.", 0, 0, "unknown"),
    ]);
    const page = await mount();
    expectShown(page, ["Avery", "Thanks for joining, let's start with the renewal.", "The quote went out on Friday.", "Jordan", "We signed it this morning."]);
  });

  test("with times, its text shows with the speakers", async () => {
    stored = JSON.stringify([
      sentence(0, "Avery", "Thanks for joining, let's start with the renewal.", 0, 4.2),
      sentence(1, "Jordan", "We signed it this morning.", 4.2, 7.9),
      sentence(2, "Avery", "Great, then we're done.", 7.9, 10.5),
    ]);
    const page = await mount();
    expectShown(page, ["Avery", "Thanks for joining, let's start with the renewal.", "Jordan", "We signed it this morning.", "Great, then we're done."]);
  });
});
