import { createPrivateKey, createPublicKey, hkdfSync, sign } from "node:crypto";
import { NodeWasmBindings, type RestorableSession, type TinyCloudNode } from "@tinycloud/node-sdk";
import { sealKeyFromDstack } from "../dstack-key";
import { OWNER_DID } from "../owner";

export interface CourierSessionProof extends Omit<RestorableSession, "jwk"> {
  siwe: string;
  signature: string;
  expiresAt: string;
  tinycloudHosts: string[];
}

export interface CourierSigner {
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** Installs the private key directly into the SDK, without returning or persisting it. */
  restoreSession(node: TinyCloudNode, session: CourierSessionProof): Promise<void>;
}

export interface CourierIdentity {
  did: string;
  publicJwk: JsonWebKey;
  signer: CourierSigner;
}

/**
 * The Courier key shares the dstack seal root with the sealed grant store, separated by the HKDF salt. That coupling is
 * deliberate: if the seal root rotates, the sealed grants no longer open either, so a fresh grant is needed regardless.
 * The same root is also the existing AES-GCM seal key, which stays unchanged because live sealed records depend on it.
 * Courier only feeds it to HKDF-SHA256 with its own salt label "tinychat-bots/courier/v1" and the owner DID as info, so
 * each owner's Ed25519 seed is domain-separated from the AES use and from every other owner.
 */
let root: Promise<Uint8Array> | undefined;
const identities = new Map<string, CourierIdentity>();
const MAX_IDENTITIES = 1024;

/** One GetKey per process; a failed fetch is not cached, so the next call retries. */
function sealRoot(): Promise<Uint8Array> {
  root ??= sealKeyFromDstack().catch(error => { root = undefined; throw error; });
  return root;
}

export async function courierIdentity(owner: string): Promise<CourierIdentity> {
  const canonical = owner.toLowerCase();
  if (!OWNER_DID.test(canonical)) throw new Error("invalid Courier owner");
  const cached = identities.get(canonical);
  if (cached) {
    identities.delete(canonical);
    identities.set(canonical, cached);
    return cached;
  }
  const seed = Buffer.from(hkdfSync("sha256", await sealRoot(), "tinychat-bots/courier/v1", canonical, 32));
  try {
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der", type: "pkcs8",
    });
    const publicJwk = createPublicKey(key).export({ format: "jwk" });
    const manager = new NodeWasmBindings().createSessionManager();
    if (!manager.replaceSessionKey) throw new Error("SDK cannot import Courier key");
    const jwk = key.export({ format: "jwk" });
    manager.replaceSessionKey(jwk, "courier");
    const did = manager.getDID("courier").split("#")[0]!;
    const identity: CourierIdentity = {
      did,
      publicJwk,
      signer: {
        async sign(bytes) { return sign(null, bytes, key); },
        async restoreSession(node, session) { await node.restoreSession({ ...session, jwk }); },
      },
    };
    identities.set(canonical, identity);
    if (identities.size > MAX_IDENTITIES) identities.delete(identities.keys().next().value!);
    return identity;
  } finally {
    seed.fill(0);
  }
}
