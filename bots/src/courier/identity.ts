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

export async function courierIdentity(owner: string): Promise<CourierIdentity> {
  const canonical = owner.toLowerCase();
  if (!OWNER_DID.test(canonical)) throw new Error("invalid Courier owner");
  const root = await sealKeyFromDstack();
  const seed = Buffer.from(hkdfSync("sha256", root, "tinychat-bots/courier/v1", canonical, 32));
  root.fill(0);
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
    return {
      did,
      publicJwk,
      signer: {
        async sign(bytes) { return sign(null, bytes, key); },
        async restoreSession(node, session) { await node.restoreSession({ ...session, jwk }); },
      },
    };
  } finally {
    seed.fill(0);
  }
}
