import { describe, expect, test } from "bun:test";

import {
  assembleSignatureState,
  computeTier,
  isEnclaveBound,
  isFresh,
  isGpuLegFresh,
  isQuoteVerified,
  parseResponseHash,
  signatureLegLabel,
} from "./verification-predicates";
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
  test("genuinely invalid → 'Signature invalid'", () => {
    expect(signatureLegLabel({ valid: false })).toBe("Signature invalid");
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
