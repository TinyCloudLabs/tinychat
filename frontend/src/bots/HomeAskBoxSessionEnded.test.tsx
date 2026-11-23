// A session that was renewed past the end of its first signed time still works for the app, but Main's history cannot be
// authorized with the first signed time. The owner is told to sign in again, in the words a send already uses.
import { afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionStore } from "@tinyboilerplate/client";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import type { BotsApi } from "./botsApi";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";

// Radix portals do not attach in happy-dom: only the dialog shell is an inline stand-in; the real body and footer stay.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
}));
const { HomeAskBox } = await import("./HomeAskBox");

const SIGN_IN_LINE = "Your session expired. Sign in again to talk to TrustBot.";
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
function pastItsFirstSignedEnd(): TinyCloudWeb {
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
    session: () => ({ ...session }),
    hasPermissions: () => true,
    setRuntimePermissionSigner: () => {},
    ensureEncryptionNetwork: async () => {},
    getEncryptionNetwork: async () => ({}),
    keys: { ensureKey: async () => descriptor },
    kvForSpace: () => ({ list: async () => ({ ok: true, data: { keys: [], truncated: false } }) }),
    signSessionBytes: async () => new Uint8Array(64),
  } as unknown as TinyCloudWeb;
}

test("Main's history, loaded with a session past its first signed end, asks the owner to sign in instead of failing quietly", async () => {
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
  await act(async () => root.render(<HomeAskBox api={api} tcw={pastItsFirstSignedEnd()} />));
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

  const chip = document.querySelector('button[aria-label="Open TrustBot\'s chat"]') as HTMLButtonElement;
  await act(async () => { chip.click(); });
  await act(async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 5)); });

  const text = document.body.textContent ?? "";
  expect(text).toContain(SIGN_IN_LINE);
  expect(text).not.toContain("earlier messages");
});
