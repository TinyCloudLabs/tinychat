import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { isConversationCanvasEligible } from "../chat/useExperimentalFeatures";
import { loadCanvasState } from "./conversationCanvasStore";

/** A space whose every storage call is recorded; the settings read answers "Canvas is on" and one promoted chat. */
function recordingTcw() {
  const opened: string[] = [];
  const tcw = {
    did: "did:example:canvas-home",
    spaceId: "space-canvas-home",
    sql: {
      db: (name: string) => {
        opened.push(name);
        return {
          query: async () => ({
            ok: true,
            data: { columns: ["key", "value"], rows: [["canvas.enabled", "true"], ["canvas.promoted.thread-1", "true"]] },
          }),
          execute: async () => ({ ok: true, data: {} }),
          batch: async () => ({ ok: true, data: {} }),
        };
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, opened };
}

test("on the Home site Canvas reads as off, with no promoted chats, even when the synced setting says on", async () => {
  const { tcw, opened } = recordingTcw();
  const state = await loadCanvasState(tcw, true);
  expect(state.enabled).toBe(false);
  expect([...state.promoted]).toEqual([]);
  expect(opened).toEqual([]);
});

test("Canvas is not offered in Settings on the Home site, and stays offered elsewhere", () => {
  expect(isConversationCanvasEligible(null, true)).toBe(false);
  expect(isConversationCanvasEligible(null, false)).toBe(true);
});
