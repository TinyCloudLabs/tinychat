import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { decodeBase64Url, parseCompactUcanAuthorization, verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { renewalVerifyProof, verifyRenewedSession, type VerifyRenewedSessionBody } from "../auth.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function didKeyFromRaw(publicKey: Uint8Array): string {
  const bytes = Uint8Array.from([0xed, 0x01, ...publicKey]);
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return `did:key:z${out}`;
}

/** A restored-session stand-in backed by a real Ed25519 session key. */
function restoredTcw() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return {
    session: () => ({ address: "0xAbC", walletAddress: "0xAbC", chainId: 1, sessionKey: "default", siwe: "owner siwe", signature: "0xsig" }),
    accountAuthorizationCid: () => "bafygrant",
    sessionDid: didKeyFromRaw(raw),
    signSessionBytes: async (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, privateKey)),
    activeNodeIdentity: async () => ({ origin: "https://node.example", nodeDid: "did:key:z6MkNode" }),
  };
}

describe("renewalVerifyProof", () => {
  test("signs the holder proof and a 60-second status invocation with the session key", async () => {
    const tcw = restoredTcw();
    const proof = await renewalVerifyProof({ tcw, backendOrigin: "https://api.example.com", address: "0xAbC", nonce: "n-1" });

    expect(proof.delegation).toEqual({ message: "owner siwe", signature: "0xsig", delegationCid: "bafygrant" });
    const message = new TextEncoder().encode("tinychat-renewal-verify|https://api.example.com|0xabc|bafygrant|n-1");
    expect(await verifyDidKeyEd25519Signature(tcw.sessionDid, message, decodeBase64Url(proof.holderProof))).toBe(true);

    const { payload } = parseCompactUcanAuthorization(proof.statusInvocation);
    expect(payload.iss).toBe(`${tcw.sessionDid}#${tcw.sessionDid.slice("did:key:".length)}`);
    expect(payload.aud).toBe("did:key:z6MkNode");
    expect(payload.att).toEqual({ "urn:cid:bafygrant": { "tinycloud.delegation/status": [{}] } });
    expect(payload.prf).toEqual([]);
    expect(payload.nnc).toBe("n-1");
    expect(payload.exp - (payload.nbf ?? 0)).toBe(60);
  });
});

describe("verifyRenewedSession", () => {
  const originalFetch = globalThis.fetch;
  const body: VerifyRenewedSessionBody = {
    address: "0xabc",
    nonce: "n-1",
    delegation: { message: "owner siwe", signature: "0xsig", delegationCid: "bafygrant" },
    leaseAuthorization: "Bearer lease",
    holderProof: "proof",
    statusInvocation: "Bearer status",
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts the proofs with the CSRF header and returns the renewed session", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const response = { token: "t", expiresIn: 3600, address: "0xabc", renewal: { effectiveEnd: 1_900_000_000 } };
    globalThis.fetch = (async (input: string | URL | Request, requestInit?: RequestInit) => {
      url = String(input);
      init = requestInit;
      return Response.json(response);
    }) as typeof fetch;

    expect(await verifyRenewedSession("https://api.example.com", body)).toEqual(response);
    expect(url).toBe("https://api.example.com/api/auth/verify-renewal");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" });
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  test.each([401, 403, 429, 503])("a %d refusal throws with its status", async (status) => {
    globalThis.fetch = (async () => Response.json({ error: "renewal_inactive" }, { status })) as unknown as typeof fetch;
    const error = await verifyRenewedSession("https://api.example.com", body).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status, message: "Renewed session verification failed: renewal_inactive" });
  });

  test("a network failure throws as fetch does, without a status", async () => {
    const failure = new TypeError("fetch failed");
    globalThis.fetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;
    const error = await verifyRenewedSession("https://api.example.com", body).catch((caught: unknown) => caught);
    expect(error).toBe(failure);
    expect(error).not.toHaveProperty("status");
  });
});
