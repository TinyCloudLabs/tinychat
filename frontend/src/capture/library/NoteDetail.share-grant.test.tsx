import { afterAll, afterEach, beforeAll, expect, spyOn, test, type Mock } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { AddressedSharePublishOptions, PublishedShare } from "@tinycloud/share-sdk";
import type { OpenKeyError } from "@openkey/sdk";
import { canonicalHashHex } from "@tinycloud/sdk-core";
import { sha256 } from "@noble/hashes/sha256";
import { CONNECTORS_SQL_DB_NAME } from "@tinyboilerplate/core";
import { installDom } from "@/test/dom";
import { encryptionNetworkId } from "@/lib/connectors/encryptionGrant";
import { associateStorageAccountClient, beginStorageAccountSession, endStorageAccountSession, __resetStorageStatusForTests } from "@/lib/storageStatus";
import * as share from "@/lib/exoTranscriptShare";
import type { Library } from "./useLibrary";

// Real published WebSDK consent/signing/activation; transport and subsequent
// storage/encryption/publisher effects are fixtures, not a live Share proof.
const ISOLATED = process.env.TC2192_GRANT_TEST_CHILD === "1";
const HOST = "http://127.0.0.1:31992";
const ORIGINS = { apiOrigin: "http://127.0.0.1:31993", shareOrigin: "http://127.0.0.1:31994", localOnly: true };
const ITEM = { id: "synthetic-grant-note", source: "fireflies", sourceId: "synthetic-grant-source", title: "Synthetic grant refresh", startedAt: null, durationSecs: null };
const SENTENCES = [{ index: 0, text: "Synthetic persisted transcript.", speaker_name: "Speaker", start_time: 0, end_time: 0 }];
const noop = () => {};
const publish = share.publishTranscriptShare;
const originalFetch = globalThis.fetch;
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
let cleanupDom: () => void;
let root: Root | null = null;
let sdk: TinyCloudWeb | undefined;
let createRoot: typeof import("react-dom/client").createRoot;
let flushSync: typeof import("react-dom").flushSync;
let NoteDetail: typeof import("./NoteDetail").NoteDetail;
let stopPublish: Mock<typeof share.publishTranscriptShare> | undefined;
let releaseNameWrite = noop;

if (ISOLATED) {
beforeAll(async () => {
  cleanupDom = installDom();
  Object.defineProperty(window, "top", { configurable: true, value: window });
  Object.defineProperty(globalThis, "location", { configurable: true, value: window.location });
  ({ createRoot } = await import("react-dom/client"));
  ({ flushSync } = await import("react-dom"));
  ({ NoteDetail } = await import("./NoteDetail"));
});
afterEach(async () => {
  releaseNameWrite();
  releaseNameWrite = noop;
  if (root) await act(async () => root!.unmount());
  root = null;
  sdk?.cleanup(); sdk = undefined;
  // The SDK removes its dismissed permission modal after its 200ms transition.
  await act(async () => { await Bun.sleep(220); });
  stopPublish?.mockRestore(); stopPublish = undefined;
  globalThis.fetch = originalFetch;
  __resetStorageStatusForTests();
});
afterAll(() => {
  if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
  else Reflect.deleteProperty(globalThis, "location");
  cleanupDom();
});
}

function grantTest(name: string, run: () => Promise<void>) {
  // Radix and SDK UI cache DOM availability at import time. Isolate each real
  // modal journey from SSR imports and the SDK's process-global UI registry.
  test(name, ISOLATED ? run : async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", `^${name.replaceAll(".", "\\.")}$`], {
      env: { ...process.env, TC2192_GRANT_TEST_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
  }, 15_000);
}

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await Bun.sleep(5); });
    if (check()) return;
  }
  throw new Error(`Timed out: ${label}`);
}
function sdkApprove(): HTMLButtonElement | undefined {
  const roots = new Set<ParentNode>([document]);
  for (const root of roots) for (const element of root.querySelectorAll("*")) if (element.shadowRoot) roots.add(element.shadowRoot);
  return [...roots].flatMap((root) => [...root.querySelectorAll<HTMLButtonElement>("button")]).find((node) => node.textContent?.trim() === "Approve");
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}: ${document.body.textContent}`);
  return found;
}
async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "mouse" }));
    node.click();
  });
}
function library(text = SENTENCES[0]!.text, speakerNames: Readonly<Record<string, string>> = {}): Library {
  // Rehydrated objects deliberately retain identical persisted content and source identity.
  const item = { ...ITEM };
  return { status: "ready", listing: false, items: [item], all: [item], isCombinedMember: () => false,
    filter: "all", setFilter: noop, refresh: noop, retry: noop,
    note: { item, audio: null, reads: { metadata: { status: "ok", metadata: { speaker_names: speakerNames } },
      transcript: { transcript: { status: "ok", sentences: SENTENCES.map((sentence) => ({ ...sentence, text })) }, provenance: null } } },
  } as Library;
}

async function fixture() {
  const requests: string[] = [];
  let signatures = 0;
  let cancelSigning = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== HOST) throw new Error("Non-fixture SDK request refused");
    requests.push(url.pathname);
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "1.20.2", features: ["encryption-named-keys-v1"] });
    if (url.pathname === "/delegate") return Response.json({ activated: [], skipped: [] });
    if (url.pathname === `/encryption/networks/${encodeURIComponent(network)}`) return Response.json({ networkId: network, ownerDid: network.slice(25, -8), state: "active" });
    throw new Error(`Unexpected fixture SDK route: ${url.pathname}`);
  }) as typeof fetch;
  // Existing repository unit-test owner key. No account/service is created and no fetch leaves this fixture.
  const signer = new PrivateKeySigner("11".repeat(32));
  const network = encryptionNetworkId(await signer.getAddress());
  const { TinyCloudWeb: Web } = await import("@tinycloud/web-sdk");
  sdk = new Web({ tinycloudHosts: [HOST], provider: {
    request: async ({ method, params }: { method: string; params?: string[] }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [await signer.getAddress()];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        signatures++;
        // @openkey/sdk 0.12.2 rejects with a plain OpenKeyError, not an Error instance.
        if (cancelSigning) throw { code: "USER_CANCELLED", message: "User cancelled the request" } satisfies OpenKeyError;
        return signer.signMessage(new TextDecoder().decode(Buffer.from(params![0]!.slice(2), "hex")));
      }
      throw new Error(`Unexpected fixture wallet method: ${method}`);
    },
  }, autoCreateSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false, ui: { button: false },
    manifest: { app_id: "xyz.tinycloud.tinychat", name: "Offline Share grant regression", permissions: [
      { service: "tinycloud.kv", path: "connectors/", actions: ["get", "put"] },
      { service: "tinycloud.sql", path: CONNECTORS_SQL_DB_NAME, actions: ["read"], skipPrefix: true },
      { service: "tinycloud.encryption", path: network, actions: ["decrypt"], skipPrefix: true },
    ] },
  });
  await sdk.signIn({ nonce: "offlinegrant2192" });
  const live = sdk;
  const sessionDid = live.sessionDid;
  signatures = 0; requests.length = 0;
  let afterGrant: () => Promise<void> = async () => {};
  let beforeResult: () => void | Promise<void> = noop;
  let grantCount = 0;
  let createdKeys = 0;
  let published: AddressedSharePublishOptions | undefined;
  const completed = Promise.withResolvers<void>();
  let storedSpeakerNames: Readonly<Record<string, string>> = {};
  const nameWrite = Promise.withResolvers<void>();
  releaseNameWrite = () => nameWrite.resolve();
  const db = {
    query: async (sql: string) => ({ ok: true, data: { rows: sql.startsWith("SELECT id FROM") ? [[ITEM.id]]
      : sql.startsWith("SELECT metadata FROM") ? [[JSON.stringify({ speaker_names: storedSpeakerNames })]] : [] } }),
    execute: async () => { await nameWrite.promise; return { ok: true, data: { changes: 1 } }; },
  };
  const keys = {
    getPublicKey: async () => ({}),
    createKey: async (path: string) => { createdKeys++; return { networkId: network, keyPath: path, keyVersion: 3, state: "active" }; },
    encrypt: async (path: string) => ({ v: 2, networkId: network, keyPath: path, keyVersion: 3, alg: "X25519-HKDF-SHA256-AES-256-GCM",
      encryptedSymmetricKey: "AQIDBA==", encryptedSymmetricKeyHash: canonicalHashHex(sha256, "AQIDBA=="), ciphertext: Buffer.alloc(28, 1).toString("base64") }),
  };
  const overrides = {
    sql: { db: () => db }, keys,
    kv: { get: async () => ({ ok: true, data: { data: JSON.stringify(SENTENCES) } }), put: async () => ({ ok: true }) },
    activeNodeIdentity: async () => ({ origin: HOST, nodeDid: "did:key:z6MktestNode" }),
    getEncryptionNetwork: async () => ({ networkId: network, ownerDid: network.slice(25, -8), state: "active" }),
    requestPermissions: async (...args: Parameters<TinyCloudWeb["requestPermissions"]>) => {
      const result = await live.requestPermissions(...args);
      if (result.approved) { grantCount += result.delegations?.length ?? 0; await afterGrant(); }
      return result;
    },
  };
  function client(): TinyCloudWeb {
    return new Proxy(live, { get(target, key) {
      if (key in overrides) return overrides[key as keyof typeof overrides];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const first = client();
  const scope = beginStorageAccountSession(first, live.did ?? null, live.spaceId ?? null);
  associateStorageAccountClient(live, scope);
  stopPublish = spyOn(share, "publishTranscriptShare").mockImplementation((input) => publish(input, {
    assertFits: async () => {},
    publish: async (input) => {
      published = input;
      const result = { protocol: "tinycloud-share", version: 1, link: { kind: "policy", cid: "fixture" }, metadata: {
        protocol: "tinycloud-share", version: 1, shareId: input.shareId, origin: ORIGINS.shareOrigin,
        target: { kind: "email", origin: HOST, nodeAudience: "did:key:z6MktestNode", spaceId: live.spaceId },
        resource: input.resource, actions: input.policyActions, expiresAt: input.expiresAt.toISOString(),
        display: { filename: input.filename }, recipientMatcher: { kind: "exactEmail", value: "qa@example.test" },
        ownerDid: live.credentialHolderDid, ownerDelegationCid: "owner", enforcementDelegationCid: "enforcement", policyCid: "policy",
      } };
      Object.defineProperty(result, "url", { value: `${ORIGINS.shareOrigin}/s/full#fixture-recipient-link` });
      return result as PublishedShare;
    },
  }).then(async (result) => { await beforeResult(); return result; }).finally(completed.resolve));
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  async function render(tcw = first, text = SENTENCES[0]!.text, names = storedSpeakerNames) {
    storedSpeakerNames = names;
    await act(async () => { flushSync(() => { root!.render(<MemoryRouter><NoteDetail library={library(text, names)} tcw={tcw} pushed={false} onBack={noop} transcription={undefined} transcriptShareOrigins={ORIGINS} /></MemoryRouter>); }); });
  }
  await render();
  return { live, first, scope, render, completed: completed.promise,
    afterGrant: (callback: () => Promise<void>) => { afterGrant = callback; },
    cancelSigning: () => { cancelSigning = true; },
    beforeResult: (callback: () => void | Promise<void>) => { beforeResult = callback; },
    refresh: async () => { const next = client(); associateStorageAccountClient(next, scope); await render(next); },
    grantCount: () => grantCount, createdKeys: () => createdKeys, published: () => published,
    signatures: () => signatures, requests, sessionDid,
  };
}

async function reviewShare() {
  await click(button("Share"));
  const input = document.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "qa@example.test");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => { input.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
}
async function startShare() {
  await reviewShare();
  await click(button("Share transcript"));
  await until(() => sdkApprove() !== undefined, "real SDK permission modal");
}
async function approveGrant(completed: Promise<void>) {
  const approve = sdkApprove()!;
  // Happy DOM has no layout. Represent the visible SDK control's centre for its normal hit test.
  approve.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON() {} });
  Object.defineProperty(approve.getRootNode(), "elementFromPoint", { configurable: true, value: () => approve });
  await act(async () => {
    approve.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, pointerType: "mouse" }));
    approve.click();
    await completed;
  });
}

grantTest("real beta.21 key.create activation survives a same-owner SDK and source refresh", async () => {
  const f = await fixture();
  f.afterGrant(f.refresh);
  await startShare();
  await approveGrant(f.completed);
  expect(f.grantCount()).toBe(1);
  expect(f.signatures()).toBe(1);
  expect(f.requests.filter((path) => path === "/delegate")).toHaveLength(1);
  expect(f.live.sessionDid).toBe(f.sessionDid);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(`${ORIGINS.shareOrigin}/s/full#fixture-recipient-link`);
  expect(f.createdKeys()).toBe(1);
  expect(f.published()?.target).toEqual({ kind: "email", address: "qa@example.test" });
});

grantTest("a new Share review carries saved aliases without changing the stored transcript", async () => {
  const f = await fixture();
  await f.render(f.first, SENTENCES[0]!.text, { Speaker: "Alice" });
  await reviewShare();
  expect(document.querySelector('pre')?.textContent).toBe("Alice: Synthetic persisted transcript.");
  expect(SENTENCES[0]!.speaker_name).toBe("Speaker");
  expect(f.grantCount()).toBe(0);
  expect(f.createdKeys()).toBe(0);
  expect(f.published()).toBeUndefined();
});

grantTest("alias-only map changes with identical snapshot text abort an in-flight share", async () => {
  const f = await fixture();
  const before = { Unused: "Before" };
  const after = { Unused: "After" };
  const snapshot = (names: Readonly<Record<string, string>>) => share.transcriptShareSnapshot(ITEM,
    { status: "ok", metadata: { speaker_names: names } }, { status: "ok", sentences: SENTENCES })!;
  expect(snapshot(before).rawText).toBe(snapshot(after).rawText);
  expect(snapshot(before).text).toBe(snapshot(after).text);
  await f.render(f.first, SENTENCES[0]!.text, before);
  f.afterGrant(() => f.render(f.first, SENTENCES[0]!.text, after));
  await startShare();
  await approveGrant(f.completed);
  expect(f.grantCount()).toBe(1);
  expect(f.createdKeys()).toBe(0);
  expect(f.published()).toBeUndefined();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("The note or account changed. Review the transcript again.");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('input[readonly]')).toBeNull();
  expect(document.body.textContent).not.toContain("qa@example.test");
});

grantTest("an optimistic speaker rename aborts sharing before its metadata write lands", async () => {
  const f = await fixture();
  f.afterGrant(async () => {
    await click(document.querySelector<HTMLElement>('[data-testid="speaker-label"]')!);
    const form = document.querySelector<HTMLFormElement>('[data-testid="speaker-rename-form"]')!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "Alice");
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-testid="speaker-label"]')?.textContent).toBe("Alice");
  });
  await startShare();
  await approveGrant(f.completed);
  expect(f.createdKeys()).toBe(0);
  expect(f.published()).toBeUndefined();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("The note or account changed. Review the transcript again.");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('input[readonly]')).toBeNull();
  expect(document.body.textContent).not.toContain("qa@example.test");
});

grantTest("equivalent speaker maps survive a same-owner grant refresh regardless of object or entry order", async () => {
  const f = await fixture();
  await f.render(f.first, SENTENCES[0]!.text, { Speaker: "Alice", Unused: "Other" });
  f.afterGrant(() => f.render(f.first, SENTENCES[0]!.text, { Unused: "Other", Speaker: "Alice" }));
  await startShare();
  await approveGrant(f.completed);
  expect(f.grantCount()).toBe(1);
  expect(f.createdKeys()).toBe(1);
  expect(f.published()?.target).toEqual({ kind: "email", address: "qa@example.test" });
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(`${ORIGINS.shareOrigin}/s/full#fixture-recipient-link`);
});

grantTest("a speaker alias changed at completion hides the stale recipient and link and reports the abort", async () => {
  const f = await fixture();
  f.beforeResult(() => f.render(f.first, SENTENCES[0]!.text, { Speaker: "Alice" }));
  await startShare();
  await approveGrant(f.completed);
  expect(f.grantCount()).toBe(1);
  expect(f.published()).toBeDefined();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("The note or account changed. Review the transcript again.");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('input[readonly]')).toBeNull();
  expect(document.body.textContent).not.toContain("qa@example.test");
});

for (const transition of ["account switch", "sign-out", "retired storage scope", "changed transcript", "explicit cancellation"] as const) {
  grantTest(`real beta.21 grant activation followed by ${transition} stops publication and reports the abort`, async () => {
    const f = await fixture();
    f.afterGrant(async () => {
      if (transition === "account switch") {
        const address = "0x0000000000000000000000000000000000000002";
        const owner = `did:pkh:eip155:1:${address}`;
        const next = new Proxy(f.first, { get(target, key) {
          if (key === "did") return owner;
          if (key === "spaceId") return `tinycloud:pkh:eip155:1:${address}:applications`;
          if (key === "sessionDid" || key === "credentialHolderDid") return "did:example:other-session";
          if (key === "session") return () => ({ ...f.live.session(), walletAddress: address, address });
          return Reflect.get(target, key);
        } });
        beginStorageAccountSession(next, owner, next.spaceId);
        await f.render(next);
      } else if (transition === "sign-out") {
        endStorageAccountSession();
        const next = new Proxy(f.first, { get(target, key) {
          if (key === "session") return () => undefined;
          if (key === "spaceId") return undefined;
          return Reflect.get(target, key);
        } });
        await f.render(next);
      } else if (transition === "retired storage scope") {
        // Cancellation must not depend on a parent render having reached this child.
        endStorageAccountSession();
      } else if (transition === "changed transcript") {
        await f.render(f.first, "A different persisted transcript.");
      } else {
        await click(button("Cancel"));
      }
    });
    await startShare();
    await approveGrant(f.completed);
    expect(f.grantCount()).toBe(1);
    expect(f.createdKeys()).toBe(0);
    expect(f.published()).toBeUndefined();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(transition === "explicit cancellation"
      ? "Sharing was cancelled." : "The note or account changed. Review the transcript again.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("qa@example.test");
    expect(document.querySelector('input[readonly]')).toBeNull();
  });
}

grantTest("a retired account at completion reports an abort instead of silently dropping the link", async () => {
  const f = await fixture();
  f.beforeResult(endStorageAccountSession);
  await startShare();
  await approveGrant(f.completed);
  expect(f.grantCount()).toBe(1);
  expect(f.createdKeys()).toBe(1);
  expect(f.published()).toBeDefined();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("The note or account changed. Review the transcript again.");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('input[readonly]')).toBeNull();
  expect(document.body.textContent).not.toContain("qa@example.test");
});

grantTest("OpenKey USER_CANCELLED during real SDK exact-key consent takes the clean cancellation path", async () => {
  const f = await fixture();
  f.cancelSigning();
  await startShare();
  await approveGrant(f.completed);
  expect(f.signatures()).toBe(1); // One signing request, rejected without producing a signature.
  expect(f.grantCount()).toBe(0);
  expect(f.requests.filter((path) => path === "/delegate")).toHaveLength(0);
  expect(f.createdKeys()).toBe(0);
  expect(f.published()).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Sharing was cancelled.");
  expect(document.querySelector('input[readonly]')).toBeNull();
});
