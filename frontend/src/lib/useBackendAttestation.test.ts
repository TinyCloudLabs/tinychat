import { describe, expect, test } from "bun:test";
import { sha256, toBytes } from "viem";
import attestation from "./backendAttestation/__fixtures__/attestation.json";
import phalaVerify from "./backendAttestation/__fixtures__/phala-verify.json";
import type { BackendSelfAttestation } from "./backendAttestation";
import { recomputeReportData, type VerifyDeps } from "./backendAttestation/verify";
import { replayRtmr3 } from "./backendAttestation/rtmr3";
import {
  resolveBackendVerdict,
  type UseBackendAttestationInput,
} from "./useBackendAttestation";

const att = attestation as unknown as BackendSelfAttestation;

// Stub the vendored verifiers so the mapping runs over the REAL prod capture
// without touching the network.
const stubDeps: Partial<VerifyDeps> = {
  checkTdxQuote: async () => ({
    verified: phalaVerify.quote.verified,
    message: undefined,
    quote: phalaVerify.quote as never,
  }),
  verifyOnchain: async () => ({
    verified: true,
    quoteHash: "0xdeadbeef",
    network: "Automata Mainnet",
    contract: "0xE26E11B257856B0bEBc4C759aaBDdea72B64351F",
    explorer:
      "https://explorer.ata.network/address/0xE26E11B257856B0bEBc4C759aaBDdea72B64351F",
  }),
};

const baseInput: UseBackendAttestationInput = {
  backendUrl: "https://api.example.test",
  // resolveBackendVerdict never touches sessionStore (only runVerification does).
  sessionStore: {} as never,
  serverInfoDid: att.identity.did,
  deps: stubDeps,
};

describe("resolveBackendVerdict (client result → status mapping)", () => {
  test("an available attestation runs verify and maps to a verdict", async () => {
    const resolved = await resolveBackendVerdict(
      { status: "available", attestation: att },
      baseInput,
    );
    // With the real prod fixture app_compose is absent ⇒ compose leg incomplete
    // ⇒ not attested, but the verdict + attestation are surfaced honestly.
    expect(resolved.status).toBe("unattested");
    expect(resolved.verdict).not.toBeNull();
    expect(resolved.verdict?.attested).toBe(false);
    expect(resolved.verdict?.legQuote.ok).toBe(true);
    expect(resolved.verdict?.legBinding.ok).toBe(true);
    expect(resolved.attestation).toBe(att);
    expect(resolved.message).toBeNull();
  });

  test("a fully-attested verdict maps to status==='attested'", async () => {
    // Synthesize the one case the prod capture can't express: app_compose
    // present so all three legs pass ⇒ resolveBackendVerdict yields 'attested'.
    const appCompose = '{"runner":"docker-compose","name":"tinychat"}';
    const composeHash = sha256(toBytes(appCompose)).slice(2);
    const eventLog = JSON.stringify([
      { imr: 3, event_type: 134217729, digest: "", event: "compose-hash", event_payload: composeHash },
    ]);
    const rtmr3 = await replayRtmr3(eventLog);
    const reportdata = recomputeReportData(att.identity.address, att.identity.nonce);
    const attestedDeps: Partial<VerifyDeps> = {
      ...stubDeps,
      checkTdxQuote: async () => ({
        verified: true,
        quote: {
          ...phalaVerify.quote,
          body: { ...phalaVerify.quote.body, reportdata, rtmr3: "0x" + rtmr3 },
        } as never,
      }),
    };
    const syntheticAtt = {
      ...att,
      event_log: eventLog,
      info: { ...att.info, compose_hash: composeHash, app_compose: appCompose },
    } as unknown as BackendSelfAttestation;

    const resolved = await resolveBackendVerdict(
      { status: "available", attestation: syntheticAtt },
      { ...baseInput, deps: attestedDeps },
    );
    expect(resolved.status).toBe("attested");
    expect(resolved.verdict?.attested).toBe(true);
  });

  test("unavailable passes through with its message and no verify", async () => {
    const resolved = await resolveBackendVerdict(
      { status: "unavailable", message: "Not attestable here." },
      baseInput,
    );
    expect(resolved.status).toBe("unavailable");
    expect(resolved.message).toBe("Not attestable here.");
    expect(resolved.verdict).toBeNull();
    expect(resolved.attestation).toBeNull();
  });

  test("unauthenticated passes through with its message", async () => {
    const resolved = await resolveBackendVerdict(
      { status: "unauthenticated", message: "Sign in again." },
      baseInput,
    );
    expect(resolved.status).toBe("unauthenticated");
    expect(resolved.message).toBe("Sign in again.");
    expect(resolved.verdict).toBeNull();
  });

  test("error passes through with its message", async () => {
    const resolved = await resolveBackendVerdict(
      { status: "error", message: "boom" },
      baseInput,
    );
    expect(resolved.status).toBe("error");
    expect(resolved.message).toBe("boom");
    expect(resolved.verdict).toBeNull();
  });
});
