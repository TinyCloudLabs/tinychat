import { createECDH, hkdfSync } from "node:crypto";
import { openRelayResult, signerFromSeed, type RelayKeyPair } from "@tinycloud/share-envelope/links";
import { DstackUnixClient, type DstackKeyClient } from "../attestation/dstackClient.js";
import type { HolderDeriver, OwnerDid, StandingHolder } from "./standing-types.js";

export const STANDING_HOLDER_ROOT = "tinychat/trustbot-standing-reads/holder-root/v1";
const DSTACK_SOCKET = "/var/run/dstack.sock";
const NO_SALT = Buffer.alloc(0);

export interface HolderScope {
  owner: OwnerDid;
  approvalId: string;
  generation: number;
}

export interface StandingApprovalKeys extends HolderDeriver {
  sealLink<T>(scope: HolderScope, use: (key: Uint8Array) => T | Promise<T>): Promise<T>;
  relayPublicKey(scope: HolderScope): Promise<RelayKeyPair["publicJwk"]>;
  openResult(scope: HolderScope, requestId: string, encrypted: unknown): Promise<Record<string, unknown>>;
}

export class DstackStandingHolderDeriver implements StandingApprovalKeys {
  constructor(private readonly dstack: DstackKeyClient = new DstackUnixClient(DSTACK_SOCKET)) {}

  async derive(owner: OwnerDid, approvalId: string, generation: number): Promise<StandingHolder> {
    return this.#withKey({ owner, approvalId, generation }, "holder-ed25519", seed => {
      const signer = signerFromSeed(seed);
      return { did: signer.did, sign: async bytes => signer.sign(bytes) };
    });
  }

  sealLink<T>(scope: HolderScope, use: (key: Uint8Array) => T | Promise<T>): Promise<T> {
    return this.#withKey(scope, "link-aes", use);
  }

  async relayPublicKey(scope: HolderScope): Promise<RelayKeyPair["publicJwk"]> {
    return this.#withRelay(scope, relay => {
      const publicKey = relay.getPublicKey();
      return { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") };
    });
  }

  async openResult(scope: HolderScope, requestId: string, encrypted: unknown): Promise<Record<string, unknown>> {
    return this.#withRelay(scope, async relay => {
      const privateKey = relay.getPrivateKey();
      const scalar = Buffer.alloc(32);
      try {
        privateKey.copy(scalar, scalar.length - privateKey.length);
        return await openRelayResult(encrypted, requestId, scalar.toString("base64url"));
      } finally {
        privateKey.fill(0);
        scalar.fill(0);
      }
    });
  }

  async #withRelay<T>(scope: HolderScope, use: (relay: ReturnType<typeof createECDH>) => T | Promise<T>): Promise<T> {
    return this.#withKey(scope, "result-p256", (material, root) => {
      const relay = createECDH("prime256v1");
      // Rejection sampling keeps scalars uniformly distributed across the P-256 group order.
      for (let counter = 0; counter < 8; counter++) {
        const candidate = counter === 0 ? material : this.#derive(root, scope, "result-p256", counter);
        try {
          relay.setPrivateKey(candidate);
        } catch {
          continue;
        } finally {
          candidate.fill(0);
        }
        return use(relay);
      }
      throw new Error("standing_read_relay_derivation_failed");
    });
  }

  async #withKey<T>(
    scope: HolderScope,
    purpose: string,
    use: (key: Buffer, root: Buffer) => T | Promise<T>,
  ): Promise<T> {
    if (!/^did:pkh:eip155:1:0x[0-9a-f]{40}$/.test(scope.owner) || !/^[a-zA-Z0-9_-]{16,128}$/.test(scope.approvalId) ||
        !Number.isSafeInteger(scope.generation) || scope.generation < 1) throw new Error("invalid_standing_holder_scope");
    const root = await this.dstack.getKey(STANDING_HOLDER_ROOT);
    try {
      if (root.length < 32 || !root.some(byte => byte !== 0)) throw new Error("standing_holder_root_unavailable");
      const value = this.#derive(root, scope, purpose);
      try { return await use(value, root); }
      finally { value.fill(0); }
    } finally {
      root.fill(0);
    }
  }

  #derive(root: Buffer, { owner, approvalId, generation }: HolderScope, purpose: string, counter = 0): Buffer {
    // A tuple encoding keeps these independently chosen fields unambiguous across approvals.
    const info = JSON.stringify([STANDING_HOLDER_ROOT, purpose, owner, approvalId, generation, counter]);
    return Buffer.from(hkdfSync("sha256", root, NO_SALT, info, 32));
  }
}
