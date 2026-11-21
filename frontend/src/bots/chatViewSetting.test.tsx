import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { CHAT_VIEW_KEY_PREFIX, DEFAULT_CHAT_VIEW, readChatView, saveChatView, useChatView, type ChatView } from "./chatViewSetting";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const ALICE = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce";
const BOB = "did:pkh:eip155:1:0x0000000000000000000000000000000000000b0b";

test("an account that never picked gets Classic", () => {
  restore = installDom();
  expect(DEFAULT_CHAT_VIEW).toBe("classic");
  expect(readChatView(ALICE)).toBe("classic");
});

test("the choice is per account on this device, and an unknown saved value reads as the default", () => {
  restore = installDom();
  saveChatView(ALICE, "bots");
  expect(readChatView(ALICE)).toBe("bots");
  expect(readChatView(ALICE.toUpperCase())).toBe("bots");
  expect(readChatView(BOB)).toBe("classic");
  window.localStorage.setItem(`${CHAT_VIEW_KEY_PREFIX}${BOB}`, "grid");
  expect(readChatView(BOB)).toBe("classic");
});

test("a change made elsewhere in the page reaches every reader of that account, and only that account", async () => {
  restore = installDom();
  const seen: Record<string, ChatView> = {};
  function Reader({ account }: { account: string }) {
    const [view] = useChatView(account);
    seen[account] = view;
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<><Reader account={ALICE} /><Reader account={BOB} /></>));
  expect(seen).toEqual({ [ALICE]: "classic", [BOB]: "classic" });
  await act(async () => saveChatView(ALICE, "bots"));
  expect(seen).toEqual({ [ALICE]: "bots", [BOB]: "classic" });
});
