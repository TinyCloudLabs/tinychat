import { describe, expect, test } from "bun:test";
import { sha256, toBytes } from "viem";
import attestation from "./__fixtures__/attestation.json";
import phalaVerify from "./__fixtures__/phala-verify.json";
import type { BackendSelfAttestation } from "@/lib/backendAttestation";
import {
  recomputeReportData,
  verifyBackendAttestation,
  type VerifyDeps,
} from "./verify";
import { replayRtmr3 } from "./rtmr3";

const att = attestation as unknown as BackendSelfAttestation;

// Stub the vendored verifiers so we never touch the network, but feed them the
// REAL prod Phala-verify capture so the binding/compose math runs over real
// bytes (quote body reportdata + rtmr3).
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

describe("verifyBackendAttestation (real prod capture)", () => {
  test("quote leg passes via both relayed Phala and trustless on-chain", async () => {
    const verdict = await verifyBackendAttestation({
      attestation: att,
      serverInfoDid: att.identity.did,
      deps: stubDeps,
    });
    expect(verdict.legQuote.ok).toBe(true);
    expect(verdict.legQuote.subchecks[0].ok).toBe(true); // Phala
    expect(verdict.legQuote.subchecks[1].ok).toBe(true); // on-chain
    expect(verdict.legQuote.links?.[0]?.url).toContain("0xE26E11B25");
  });

  test("identity-binding leg passes against the real fixture nonce", async () => {
    const verdict = await verifyBackendAttestation({
      attestation: att,
      serverInfoDid: att.identity.did,
      deps: stubDeps,
    });
    expect(verdict.legBinding.ok).toBe(true);
    // report_data recompute (raw, zero-padded), sig recovery, DID match.
    expect(verdict.legBinding.subchecks[0].ok).toBe(true);
    expect(verdict.legBinding.subchecks[1].ok).toBe(true);
    expect(verdict.legBinding.subchecks[2].ok).toBe(true);
  });

  test("a server-info DID mismatch fails the binding leg", async () => {
    const verdict = await verifyBackendAttestation({
      attestation: att,
      // A valid but different address ⇒ DID sub-check must fail.
      serverInfoDid: "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD",
      deps: stubDeps,
    });
    expect(verdict.legBinding.subchecks[2].ok).toBe(false);
    expect(verdict.legBinding.ok).toBe(false);
    expect(verdict.attested).toBe(false);
  });

  test("compose leg is honestly incomplete when app_compose is absent", async () => {
    expect(att.info.app_compose).toBeUndefined();
    const verdict = await verifyBackendAttestation({
      attestation: att,
      serverInfoDid: att.identity.did,
      deps: stubDeps,
    });
    // RTMR3 replay + compose-hash event bind against the real bytes...
    expect(verdict.legCompose.subchecks[0].ok).toBe(true);
    expect(verdict.legCompose.subchecks[1].ok).toBe(true);
    // ...but app_compose can't be bound yet ⇒ leg incomplete, not attested.
    expect(verdict.legCompose.subchecks[2].ok).toBe(false);
    expect(verdict.legCompose.subchecks[2].detail).toContain("app-compose");
    expect(verdict.legCompose.ok).toBe(false);
    expect(verdict.attested).toBe(false);
  });

  // The real prod capture can't express a fully-attested verdict (it serves no
  // app_compose, so the compose leg is permanently incomplete). Synthesize the
  // ONLY case the capture can't: app_compose present + all three legs green.
  test("all three legs pass ⇒ attested===true (synthetic app_compose)", async () => {
    const appCompose = '{"runner":"docker-compose","name":"tinychat"}';
    const composeHash = sha256(toBytes(appCompose)).slice(2); // 64 hex, no 0x
    // A synthetic imr-3 event log whose compose-hash payload == composeHash; its
    // replay then defines the quote body's rtmr3 we feed back through the stub.
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

    const verdict = await verifyBackendAttestation({
      attestation: syntheticAtt,
      serverInfoDid: att.identity.did,
      deps: attestedDeps,
    });
    expect(verdict.legQuote.ok).toBe(true);
    expect(verdict.legBinding.ok).toBe(true);
    expect(verdict.legCompose.subchecks[0].ok).toBe(true); // rtmr3 replay
    expect(verdict.legCompose.subchecks[1].ok).toBe(true); // compose-hash event
    expect(verdict.legCompose.subchecks[2].ok).toBe(true); // sha256(app_compose)
    expect(verdict.legCompose.ok).toBe(true);
    expect(verdict.attested).toBe(true);
  });

  test("a corrupt report_data fails the binding leg without false-positive", async () => {
    const tampered: Partial<VerifyDeps> = {
      ...stubDeps,
      checkTdxQuote: async () => ({
        verified: true,
        quote: {
          ...phalaVerify.quote,
          body: {
            ...phalaVerify.quote.body,
            reportdata: "0x" + "11".repeat(64),
          },
        } as never,
      }),
    };
    const verdict = await verifyBackendAttestation({
      attestation: att,
      serverInfoDid: att.identity.did,
      deps: tampered,
    });
    expect(verdict.legBinding.subchecks[0].ok).toBe(false);
    expect(verdict.legBinding.ok).toBe(false);
    expect(verdict.attested).toBe(false);
  });
});
