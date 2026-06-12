import { describe, expect, test } from "bun:test";

import { privateKeyToAccount } from "viem/accounts";

import {
  assembleSignatureState,
  computeTier,
  isEnclaveBound,
  isFresh,
  isGpuLegFresh,
  isQuoteVerified,
  isRelayBound,
  parseResponseHash,
  signatureLegLabel,
} from "./verification-predicates";
import { relaySignMessage, type RelaySignatureFrame } from "../lib/relayFrame";
import { sha256 } from "../lib/vendor/redpill-verifier/utils";

// The enclave-attested signing key (what the TDX quote binds).
const ATTESTED = "0xAbCdEf0000000000000000000000000000000001";

/** A fully-green-eligible verifyModel result; override to flip a single leg. */
function mr(over: Record<string, unknown> = {}): any {
  return {
    onchain: { verified: true },
    signingAddress: ATTESTED,
    light: {
      tdx: { verified: true },
      reportData: { bindsAddress: true, embedsNonce: true },
    },
    ...over,
  };
}

describe("isQuoteVerified", () => {
  test("true when on-chain OR phala TDX verified, false otherwise", () => {
    expect(isQuoteVerified(mr())).toBe(true);
    expect(isQuoteVerified(mr({ onchain: { verified: false }, light: { tdx: { verified: true } } }))).toBe(true);
    expect(isQuoteVerified(mr({ onchain: null, light: { tdx: null } }))).toBe(false);
  });
});

describe("ST1 — enclave binding", () => {
  test("true only when signer === signing_address === mr.signingAddress AND bindsAddress", () => {
    expect(isEnclaveBound(mr(), ATTESTED, ATTESTED)).toBe(true);
  });

  test("self-consistent triple whose signing_address != attested key is NOT bound", () => {
    // The attack: a malicious backend returns {signer, signing_address} that
    // agree with each other but NOT with the enclave-attested key.
    const rogue = "0xBaD0000000000000000000000000000000000002";
    expect(isEnclaveBound(mr(), rogue, rogue)).toBe(false);
  });

  test("bindsAddress !== true is NOT bound", () => {
    const m = mr({ light: { tdx: { verified: true }, reportData: { bindsAddress: false, embedsNonce: true } } });
    expect(isEnclaveBound(m, ATTESTED, ATTESTED)).toBe(false);
  });

  test("signer not matching the claimed signing_address is NOT bound", () => {
    expect(isEnclaveBound(mr(), "0xCccc000000000000000000000000000000000003", ATTESTED)).toBe(false);
  });

  test("missing signature (null signer/address) is NOT bound", () => {
    expect(isEnclaveBound(mr(), null, null)).toBe(false);
  });
});

describe("ST4 — freshness", () => {
  test("fresh only when embedsNonce === true", () => {
    expect(isFresh(mr())).toBe(true);
    expect(isFresh(mr({ light: { tdx: { verified: true }, reportData: { bindsAddress: true, embedsNonce: false } } }))).toBe(false);
    expect(isFresh(mr({ light: { tdx: { verified: true }, reportData: null } }))).toBe(false);
  });
});

describe("ST2 — reply binding (hash compare)", () => {
  test("parseResponseHash pulls respHash from both 2- and 3-part sig.text", () => {
    expect(parseResponseHash("reqhash:resphash")).toBe("resphash");
    expect(parseResponseHash("model:reqhash:resphash")).toBe("resphash");
  });

  test("ST12c — parseResponseHash fails safe on unexpected colon-part counts", () => {
    // 1 part (no colon) — no hash present → undefined (→ replyBound=false).
    expect(parseResponseHash("justonepart")).toBeUndefined();
    // 4+ parts — must NOT return a model-name/hash fragment masquerading as the
    // response hash; fail safe instead.
    expect(parseResponseHash("a:b:c:d")).toBeUndefined();
    expect(parseResponseHash("a:b:c:d:e")).toBeUndefined();
    // Empty string → single empty part → undefined.
    expect(parseResponseHash("")).toBeUndefined();
  });

  test("rendered text bound only when it hashes to the signed response hash", async () => {
    const rendered = "the assistant reply we actually show";
    const respHash = await sha256(rendered);
    const sigText = `reqhash:${respHash}`;
    const parsed = parseResponseHash(sigText);
    expect((await sha256(rendered)) === parsed).toBe(true); // identical → bound
    expect((await sha256(rendered + "!")) === parsed).toBe(false); // one char changed → not bound
  });
});

describe("computeTier — green requires ALL legs", () => {
  const all = { quoteVerified: true, enclaveBound: true, replyBound: true, fresh: true };

  test("all legs true → response-verified (green)", () => {
    expect(computeTier(all)).toBe("response-verified");
  });

  test("dropping any single trust leg falls to enclave-attested (sky), never green", () => {
    expect(computeTier({ ...all, enclaveBound: false })).toBe("enclave-attested"); // ST1
    expect(computeTier({ ...all, replyBound: false })).toBe("enclave-attested"); // ST2
    expect(computeTier({ ...all, fresh: false })).toBe("enclave-attested"); // ST4
  });

  test("no verified quote → not-verifiable (grey)", () => {
    expect(computeTier({ ...all, quoteVerified: false })).toBe("not-verifiable");
  });

  test("ST7 — a thrown/malformed signature leg keeps enclave-attested, never grey", () => {
    // The ST7 path: recoverMessageAddress throws, so signer=null → enclaveBound
    // false and replyBound false, but the quote leg still verified + fresh. The
    // tier must stay sky (enclave-attested), NOT fall to grey (not-verifiable).
    expect(
      computeTier({
        quoteVerified: true,
        enclaveBound: false,
        replyBound: false,
        fresh: true,
      }),
    ).toBe("enclave-attested");
  });
});

describe("ST8 — assembleSignatureState", () => {
  const base = {
    signer: "0xSigner",
    signatureMalformed: false,
    enclaveBound: true,
    replyBound: true,
    fresh: true,
  };

  test("(a) no fetched signature → null (leg omitted, not 'invalid — signer null')", () => {
    expect(
      assembleSignatureState({ ...base, hasSignature: false, tier: "enclave-attested" }),
    ).toBeNull();
  });

  test("green tier → { valid: true }", () => {
    expect(
      assembleSignatureState({ ...base, hasSignature: true, tier: "response-verified" }),
    ).toEqual({ valid: true, signer: "0xSigner" });
  });

  test("(b) valid + reply-bound but only freshness failed → nonce_not_fresh, not invalid", () => {
    expect(
      assembleSignatureState({
        ...base,
        hasSignature: true,
        tier: "enclave-attested",
        fresh: false,
      }),
    ).toEqual({ valid: false, signer: "0xSigner", reason: "nonce_not_fresh" });
  });

  test("(c) genuinely invalid (malformed) signature → { valid: false } with no reason", () => {
    expect(
      assembleSignatureState({
        ...base,
        hasSignature: true,
        tier: "enclave-attested",
        signatureMalformed: true,
        enclaveBound: false,
        replyBound: false,
        fresh: false,
      }),
    ).toEqual({ valid: false, signer: "0xSigner" });
  });

  test("(d) enclave-bound + fresh but reply NOT bound → binding_unverifiable, not invalid", () => {
    // The RedPill gateway-rewrite case: a cryptographically valid, enclave-bound,
    // fresh signature whose signed body-hash can't be reproduced from the reply.
    expect(
      assembleSignatureState({
        ...base,
        hasSignature: true,
        tier: "enclave-attested",
        replyBound: false,
      }),
    ).toEqual({ valid: false, signer: "0xSigner", reason: "binding_unverifiable" });
  });

  test("binding_unverifiable requires enclaveBound AND fresh — a non-fresh case stays nonce_not_fresh", () => {
    // freshness failure takes precedence (it has its own, more specific honesty
    // line); only an enclave-bound + FRESH + reply-unbound signature is the
    // gateway-rewrite case.
    expect(
      assembleSignatureState({
        ...base,
        hasSignature: true,
        tier: "enclave-attested",
        replyBound: true,
        fresh: false,
      }),
    ).toEqual({ valid: false, signer: "0xSigner", reason: "nonce_not_fresh" });
  });

  test("malformed signature is never relabeled binding_unverifiable", () => {
    expect(
      assembleSignatureState({
        ...base,
        hasSignature: true,
        tier: "enclave-attested",
        signatureMalformed: true,
        enclaveBound: true,
        replyBound: false,
        fresh: true,
      }),
    ).toEqual({ valid: false, signer: "0xSigner" });
  });
});

describe("ST8 — signatureLegLabel", () => {
  test("valid → 'Signature valid'", () => {
    expect(signatureLegLabel({ valid: true })).toBe("Signature valid");
  });
  test("stale-but-valid → 'Signature valid — nonce not fresh', not 'invalid'", () => {
    expect(signatureLegLabel({ valid: false, reason: "nonce_not_fresh" })).toBe(
      "Signature valid — nonce not fresh",
    );
  });
  test("reply-unbindable-but-valid → 'Signature valid — reply binding not independently verifiable'", () => {
    expect(
      signatureLegLabel({ valid: false, reason: "binding_unverifiable" }),
    ).toBe("Signature valid — reply binding not independently verifiable");
  });
  test("genuinely invalid → 'Signature invalid'", () => {
    expect(signatureLegLabel({ valid: false })).toBe("Signature invalid");
  });
});

describe("isRelayBound — relay custody leg (hash + signer + attested address)", () => {
  // Two distinct keys: the attested relay key and an unrelated one.
  const RELAY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const OTHER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
  const relayAccount = privateKeyToAccount(RELAY_KEY);
  const otherAccount = privateKeyToAccount(OTHER_KEY);

  const RENDERED = "Hello, world!";

  /** A fully-bound frame signed by `signer` over the canonical message. */
  async function makeFrame(opts: {
    contentSha256: string;
    address: string;
    signer: typeof relayAccount;
  }): Promise<RelaySignatureFrame> {
    const partial = {
      completion_id: "chatcmpl-relay-001",
      model: "phala/gpt-oss-120b",
      content_sha256: opts.contentSha256,
    };
    const signature = await opts.signer.signMessage({
      message: relaySignMessage(partial),
    });
    return { v: 1, ...partial, signature, address: opts.address };
  }

  test("happy path — hash matches, signer recovers to frame.address === attested → true", async () => {
    const renderedHash = await sha256(RENDERED);
    const frame = await makeFrame({
      contentSha256: renderedHash,
      address: relayAccount.address,
      signer: relayAccount,
    });
    expect(
      await isRelayBound({
        renderedHash,
        frame,
        attestedRelayAddress: relayAccount.address,
      }),
    ).toBe(true);
  });

  test("case-insensitive on every comparison → still true", async () => {
    const renderedHash = await sha256(RENDERED);
    const frame = await makeFrame({
      contentSha256: (await sha256(RENDERED)).toUpperCase(),
      address: relayAccount.address.toLowerCase(),
      signer: relayAccount,
    });
    expect(
      await isRelayBound({
        renderedHash: renderedHash.toUpperCase(),
        frame,
        attestedRelayAddress: relayAccount.address.toUpperCase(),
      }),
    ).toBe(true);
  });

  test("hash mismatch — rendered bytes differ from the signed hash → false", async () => {
    const renderedHash = await sha256(RENDERED);
    const frame = await makeFrame({
      contentSha256: await sha256("a DIFFERENT reply"),
      address: relayAccount.address,
      signer: relayAccount,
    });
    expect(
      await isRelayBound({
        renderedHash,
        frame,
        attestedRelayAddress: relayAccount.address,
      }),
    ).toBe(false);
  });

  test("signer mismatch — frame signed by another key (recovers ≠ frame.address) → false", async () => {
    const renderedHash = await sha256(RENDERED);
    // frame.address claims the attested relay, but the signature is the OTHER key.
    const frame = await makeFrame({
      contentSha256: renderedHash,
      address: relayAccount.address,
      signer: otherAccount,
    });
    expect(
      await isRelayBound({
        renderedHash,
        frame,
        attestedRelayAddress: relayAccount.address,
      }),
    ).toBe(false);
  });

  test("address mismatch — frame.address ≠ attested relay address → false", async () => {
    const renderedHash = await sha256(RENDERED);
    // Self-consistent frame (signer recovers to frame.address), but that address
    // is NOT the attested relay key.
    const frame = await makeFrame({
      contentSha256: renderedHash,
      address: otherAccount.address,
      signer: otherAccount,
    });
    expect(
      await isRelayBound({
        renderedHash,
        frame,
        attestedRelayAddress: relayAccount.address,
      }),
    ).toBe(false);
  });

  test("no attestation — attestedRelayAddress null → fail closed (false)", async () => {
    const renderedHash = await sha256(RENDERED);
    const frame = await makeFrame({
      contentSha256: renderedHash,
      address: relayAccount.address,
      signer: relayAccount,
    });
    expect(
      await isRelayBound({ renderedHash, frame, attestedRelayAddress: null }),
    ).toBe(false);
  });

  test("malformed signature never throws → false", async () => {
    const renderedHash = await sha256(RENDERED);
    const frame: RelaySignatureFrame = {
      v: 1,
      completion_id: "chatcmpl-relay-001",
      model: "phala/gpt-oss-120b",
      content_sha256: renderedHash,
      signature: "0xdeadbeef",
      address: relayAccount.address,
    };
    expect(
      await isRelayBound({
        renderedHash,
        frame,
        attestedRelayAddress: relayAccount.address,
      }),
    ).toBe(false);
  });
});

describe("ST9 — isGpuLegFresh (no green for replayed GPU evidence)", () => {
  test("PASS verdict but nonceMatches=false → not fresh (non-green, not summarized)", () => {
    expect(isGpuLegFresh({ verdict: "PASS", nonceMatches: false })).toBe(false);
    expect(isGpuLegFresh({ verdict: "true", nonceMatches: false })).toBe(false);
  });
  test("PASS verdict AND nonceMatches=true → fresh (green, summarized)", () => {
    expect(isGpuLegFresh({ verdict: "PASS", nonceMatches: true })).toBe(true);
    expect(isGpuLegFresh({ verdict: "true", nonceMatches: true })).toBe(true);
  });
  test("non-passing verdict is never fresh; null gpu is never fresh", () => {
    expect(isGpuLegFresh({ verdict: "FAIL", nonceMatches: true })).toBe(false);
    expect(isGpuLegFresh(null)).toBe(false);
    expect(isGpuLegFresh(undefined)).toBe(false);
  });
});
