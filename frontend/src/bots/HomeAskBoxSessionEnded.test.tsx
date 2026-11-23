// A session that was renewed past the end of its first signed time still works for the app, but Main's history cannot be
// authorized with the first signed time. The owner is told to sign in, with a Sign in button when the box has an action for it.
import { afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionStore } from "@tinyboilerplate/client";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import type { BotsApi } from "./botsApi";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";

// Radix portals do not attach in happy-dom: the dialog shell is rendered inline; the real body and footer stay.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
}));
const { HomeAskBox } = await import("./HomeAskBox");

const SIGN_IN_LINE = "To see your earlier messages with TrustBot, sign in to TinyCloud One.";
const address = `0x${"66".repeat(20)}`;
const realFetch = globalThis.fetch;

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
  globalThis.fetch = realFetch;
});

/** A client whose signed session ended a minute ago while every grant it holds is still live. */
function pastItsFirstSignedEnd(noSession = false): TinyCloudWeb {
  const session = {
    address, chainId: 1, sessionKey: "key-1", signature: "fixture",
    siwe: `URI: did:key:fixture\nExpiration Time: ${new Date(Date.now() - 60_000).toISOString()}`,
  };
  const descriptor = {
    networkId: encryptionNetworkId(address), keyPath: BOT_HISTORY_KEY_PATH, alg: "x25519-aes256gcm/v1", keyVersion: 1,
    publicEncryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", kind: "deletable", state: "active",
  };
  return {
    did: `did:pkh:eip155:1:${address}`,
    session: () => (noSession ? undefined : { ...session }),
    hasPermissions: () => true,
    setRuntimePermissionSigner: () => {},
    ensureEncryptionNetwork: async () => {},
    getEncryptionNetwork: async () => ({}),
    keys: { ensureKey: async () => descriptor },
    kvForSpace: () => ({ list: async () => ({ ok: true, data: { keys: [], truncated: false } }) }),
    signSessionBytes: async () => new Uint8Array(64),
  } as unknown as TinyCloudWeb;
}

async function openWithEndedSession(onReconnect?: () => void, noSession = false) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, address);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(JSON.stringify(url.endsWith("/api/bots/status") ? { enabled: true } : {}), { status: url.includes("/api/bots/history/status") ? 200 : url.endsWith("/api/bots/status") ? 200 : 404 });
  }) as typeof fetch;
  const api: BotsApi = { getBotsStatus: async () => ({ enabled: true }), listMainMessages: async () => [], sendToMain: async () => {} };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<HomeAskBox api={api} tcw={pastItsFirstSignedEnd(noSession)} onReconnect={onReconnect} />));
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

  const chip = document.querySelector('button[aria-label="Open TrustBot\'s chat"]') as HTMLButtonElement;
  await act(async () => { chip.click(); });
  await act(async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 5)); });
}

const signInButton = () => [...document.querySelectorAll("button")].find(node => node.textContent === "Sign in");

test("Main's history, loaded with a session past its first signed end, asks the owner to sign in instead of failing quietly", async () => {
  await openWithEndedSession();
  const text = document.body.textContent ?? "";
  expect(text).toContain(SIGN_IN_LINE);
  expect(text).not.toContain("earlier messages with TrustBot.");
  expect(text).not.toContain("Try again");
  expect(signInButton()).toBeUndefined();
});

test("with a sign-in action available, the line has a Sign in button that runs it", async () => {
  let reconnects = 0;
  await openWithEndedSession(() => { reconnects++; });
  expect(document.body.textContent).toContain(SIGN_IN_LINE);
  await act(async () => { signInButton()!.click(); });
  expect(reconnects).toBe(1);
});

const RAW_CODES = ["history_session_expired", "history_session_missing", "history_signed_out", "signed_out", "Error"];

test("a history that cannot load because there is no session reads the same, with no error code on the page", async () => {
  await openWithEndedSession(undefined, true);
  const text = document.body.textContent ?? "";
  expect(text).toContain(SIGN_IN_LINE);
  for (const code of RAW_CODES) expect(text).not.toContain(code);
});

test("the sign-in line carries no error code when the session ended by its signed time", async () => {
  await openWithEndedSession(() => {});
  const text = document.body.textContent ?? "";
  for (const code of RAW_CODES) expect(text).not.toContain(code);
});

test("a send keeps its own line when the sign-in ran out", async () => {
  await openWithEndedSession(() => {});
  const box = document.querySelector<HTMLTextAreaElement>("textarea[placeholder='Message TrustBot']")!;
  await act(async () => {
    box.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "hi");
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Send to TrustBot"]')!.click(); });
  await act(async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 5)); });
  const text = document.body.textContent ?? "";
  expect(text).toContain("Your session expired. Sign in again to talk to TrustBot.");
  for (const code of RAW_CODES) expect(text).not.toContain(code);
});
