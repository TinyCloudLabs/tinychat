import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TinyCloudNode } from "@tinycloud/node-sdk";

// patches/@tinycloud%2Fnode-sdk@3.8.0-beta.11.patch: every sign-in signs a SIWE for a NEW session key. Unpatched, signIn()
// renames the one key it holds, so a second sign-in on the same instance reuses the first sign-in's key (TC-2130).
const realFetch = globalThis.fetch;
beforeEach(() => {
  // No network: a sign-in stops right after the SIWE is signed, which is all this reads.
  globalThis.fetch = (async (url: unknown) => { throw new Error(`no network in tests: ${String(url)}`); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const SESSION_DID = /did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}/;

async function signedSessionKeys(signIns: number): Promise<string[]> {
  const node = new TinyCloudNode({ privateKey: "11".repeat(32), host: "https://node.invalid", autoCreateSpace: false, includeAccountRegistryPermissions: false } as ConstructorParameters<typeof TinyCloudNode>[0]);
  const auth = (node as unknown as { auth: { signer: { signMessage(message: string): Promise<string> } } }).auth;
  const sign = auth.signer.signMessage.bind(auth.signer);
  const messages: string[] = [];
  auth.signer.signMessage = async (message) => { messages.push(message); return sign(message); };
  for (let i = 0; i < signIns; i++) await node.signIn().catch(() => undefined);
  return messages.map((message) => SESSION_DID.exec(message)?.[0] ?? "");
}

describe("node-sdk sign-in session key", () => {
  test("two successive sign-ins sign for different session keys", async () => {
    const keys = await signedSessionKeys(2);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.startsWith("did:key:z6Mk"))).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("two OpenKey-prepared sessions (signInWithOpenKey) get different session keys", async () => {
    const node = new TinyCloudNode({ privateKey: "11".repeat(32), host: "https://node.invalid", autoCreateSpace: false, includeAccountRegistryPermissions: false } as ConstructorParameters<typeof TinyCloudNode>[0]);
    const auth = (node as unknown as { auth: { prepareSessionForSigning(): Promise<{ keyId: string; prepared: { siwe: string } }> } }).auth;
    const first = await auth.prepareSessionForSigning();
    const second = await auth.prepareSessionForSigning();
    expect(first.keyId).not.toBe(second.keyId);
    expect(SESSION_DID.exec(first.prepared.siwe)?.[0]).not.toBe(SESSION_DID.exec(second.prepared.siwe)?.[0]);
  });
});
