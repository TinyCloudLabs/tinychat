// TC-3887: when the owner declined the encryption request, Main's chat says so in one line with a Review request
// button, in place of "Couldn't load your earlier messages" and "reply didn't come through".
import { afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BOTS_STRINGS } from "./botsStrings";
import { HISTORY_DECLINED, authorizeBotHistory, clearHistoryDecline } from "./historyAuthorization";
import type { MainChatState } from "./useMainChat";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { connectWallet } from "@tinyboilerplate/client";

// Radix portals do not attach in happy-dom: only the dialog shell is an inline stand-in; the real body and footer stay.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
}));
const { MainChat } = await import("./MainChat");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
  clearHistoryDecline();
});

const LINE = "Your chat with TrustBot needs your OK to encrypt it. Nothing is sent until you allow it.";

async function show(state: MainChatState, calls: string[]) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(
    <MainChat open onOpenChange={() => {}} state={state} onSend={() => {}} onRetry={() => calls.push("retry")} onRetryHistory={() => calls.push("retryHistory")} />,
  ));
  return () => document.body.textContent ?? "";
}
const button = () => [...document.querySelectorAll("button")].find((node) => node.textContent === BOTS_STRINGS.reviewRequest);

test("a declined history read shows the line and Review request, not the generic failure", async () => {
  const calls: string[] = [];
  const text = await show({ lines: [], history: "declined", turn: null }, calls);
  expect(text()).toContain(LINE);
  expect(text()).not.toContain("earlier messages");
  expect(button()).toBeDefined();
});

test("a send refused for the decline shows the line, not the reply failure, and Review request asks again", async () => {
  const calls: string[] = [];
  const f = { requests: 0 };
  let allowed = false;
  const session = { address: "0x" + "88".repeat(20), chainId: 1, sessionKey: "k", siwe: `Expiration Time: ${new Date(Date.now() + 3_600_000).toISOString()}` };
  const client = { session: () => ({ ...session }), hasPermissions: () => allowed, setRuntimePermissionSigner: () => {},
    requestPermissions: async () => { f.requests++; allowed = false; return { approved: false }; }, ensureEncryptionNetwork: async () => {} } as unknown as TinyCloudWeb;
  const connect = (async () => ({ address: session.address, openkey: { signMessage: async () => ({ signature: "x" }) } })) as unknown as typeof connectWallet;
  await expect(authorizeBotHistory(client, connect, async () => ({ enabled: true }))).rejects.toThrow(HISTORY_DECLINED);
  await expect(authorizeBotHistory(client, connect, async () => ({ enabled: true }))).rejects.toThrow(HISTORY_DECLINED);
  expect(f.requests).toBe(1);

  const text = await show({ lines: [], history: "loaded", turn: { text: "hello", reply: "", state: "error", error: "history_declined" } }, calls);
  expect(text()).toContain(LINE);
  expect(text()).not.toContain("reply didn't come through");
  await act(async () => { button()!.click(); });
  expect(calls).toEqual(["retry"]);
  await expect(authorizeBotHistory(client, connect, async () => ({ enabled: true }))).rejects.toThrow(HISTORY_DECLINED);
  expect(f.requests).toBe(2);
});
