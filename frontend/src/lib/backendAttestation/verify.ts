// Browser-side 3-leg verdict for the backend self-attestation quote.
//
// Wire contract: docs/backend-attestation-plan.md §5. The served attestation is
//   { quote, event_log, report_data, identity:{did,address,nonce,nonce_signature},
//     info:{app_id,instance_id,compose_hash,os_image_hash,app_compose?} }.
//
// The verdict has three legs; ALL must pass for an overall "attested" verdict:
//   - legQuote   = phala-verify (RELAYED, via vendored checkTdxQuote) OR
//                  Automata on-chain DCAP (TRUSTLESS, via vendored verifyOnchain).
//   - legBinding = the quote body's report_data is the locally-recomputed
//                  sha256(PREFIX || getAddress(address) || nonce) zero-padded to
//                  64 bytes (RAW, not re-hashed), AND the nonce signature recovers
//                  the same address, AND that address matches the /api/server-info
//                  DID.
//   - legCompose = RTMR3 replay == quote body rtmr3 AND the compose-hash event
//                  payload == info.compose_hash AND sha256(app_compose) ==
//                  compose_hash. The last sub-check is FAIL-HONEST when
//                  info.app_compose is absent (current prod) — never fabricated.
//
// Ground truth: REAL prod capture, 2026-06-11 (see the fixtures + R0 spike plan).
// Any null/thrown sub-check ⇒ that leg fails ⇒ overall NOT attested (we never
// false-positive).

import { getAddress, recoverMessageAddress, sha256, toBytes, type Hex } from "viem";
import {
  checkTdxQuote as vendoredCheckTdxQuote,
  verifyOnchain as vendoredVerifyOnchain,
} from "@/lib/vendor/redpill-verifier";
import type { BackendSelfAttestation } from "@/lib/backendAttestation";
import { extractComposeHashEvent, replayRtmr3 } from "./rtmr3";

/** Domain-separation prefix baked into the report_data preimage (prod-exact). */
export const ATTEST_PREFIX = "tinychat-backend-attest-v1";

export interface VerdictLink {
  label: string;
  url: string;
}

export interface SubCheck {
  ok: boolean;
  label: string;
  detail: string;
}

export interface LegResult {
  ok: boolean;
  label: string;
  detail: string;
  subchecks: SubCheck[];
  links?: VerdictLink[];
}

export interface BackendVerdict {
  attested: boolean;
  legQuote: LegResult;
  legBinding: LegResult;
  legCompose: LegResult;
}

/** Injectable vendored verifiers (stubbed in tests to avoid the network). */
export interface VerifyDeps {
  checkTdxQuote: typeof vendoredCheckTdxQuote;
  verifyOnchain: typeof vendoredVerifyOnchain;
}

export interface VerifyInput {
  attestation: BackendSelfAttestation;
  /**
   * The DID served by /api/server-info, fetched independently so the binding
   * leg can cross-check it against the attestation identity. When absent, the
   * DID sub-check is fail-honest (it cannot be completed).
   */
  serverInfoDid?: string;
  deps?: Partial<VerifyDeps>;
}

async function tryAsync<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function trySync<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Parse the EIP-55 address out of a `did:pkh:eip155:<chain>:0x..` DID. */
export function addressFromDid(did: string): string | null {
  const match = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(did.trim());
  if (!match) return null;
  return trySync(() => getAddress(match[1]));
}

/**
 * Recompute the expected quote body report_data: sha256 over the UTF-8
 * concatenation of PREFIX, the EIP-55 checksummed address, and the nonce, then
 * zero-padded to 64 bytes. Returns lowercase `0x` + 128 hex.
 */
export function recomputeReportData(address: string, nonce: string): string {
  const checksummed = getAddress(address);
  const hash = sha256(toBytes(ATTEST_PREFIX + checksummed + nonce)); // 0x + 64 hex
  return (hash + "0".repeat(64)).toLowerCase();
}

export async function verifyBackendAttestation(
  input: VerifyInput,
): Promise<BackendVerdict> {
  const { attestation, serverInfoDid } = input;
  const checkTdxQuote = input.deps?.checkTdxQuote ?? vendoredCheckTdxQuote;
  const verifyOnchain = input.deps?.verifyOnchain ?? vendoredVerifyOnchain;
  const { identity, info } = attestation;

  // ── legQuote: relayed Phala OR trustless on-chain ───────────────────────
  const tdx = await tryAsync(() => checkTdxQuote(attestation.quote));
  const onchain = await tryAsync(() =>
    verifyOnchain(attestation.quote, "automata-mainnet"),
  );
  const phalaVerified = tdx?.quote?.verified === true;
  const onchainVerified = onchain?.verified === true;

  const legQuote: LegResult = {
    ok: phalaVerified || onchainVerified,
    label: "Quote validity",
    detail: phalaVerified || onchainVerified
      ? "The TDX quote is accepted by at least one independent verifier."
      : "No verifier accepted the TDX quote.",
    subchecks: [
      {
        ok: phalaVerified,
        label: "Phala verifier — relayed",
        detail: phalaVerified
          ? "Phala's DCAP service verified the quote."
          : "Phala did not verify the quote.",
      },
      {
        ok: onchainVerified,
        label: "Automata on-chain DCAP — trustless",
        detail: onchainVerified
          ? "Automata's on-chain contract verified the quote."
          : "Automata on-chain verification did not pass (or was unavailable).",
      },
    ],
    links: onchain?.explorer
      ? [{ label: "Automata DCAP contract", url: onchain.explorer }]
      : undefined,
  };

  // The Intel-signed quote body carries the authoritative report_data + rtmr3.
  // NOTE: these parsed body fields come ONLY from the Phala verifier result. The
  // Automata on-chain verifier returns quote validity but no parsed body, so
  // legBinding and legCompose require Phala's body; in a Phala-down / Automata-up
  // case legQuote can pass while binding/compose stay fail-safe (unattested).
  const body = tdx?.quote?.body;
  const quoteReportData = typeof body?.reportdata === "string" ? body.reportdata : null;
  const quoteRtmr3 = typeof body?.rtmr3 === "string" ? (body.rtmr3 as string) : null;

  // ── legBinding: report_data recompute + sig recovery + DID match ─────────
  const expectedReportData = trySync(() =>
    recomputeReportData(identity.address, identity.nonce),
  );
  const reportDataOk =
    expectedReportData != null &&
    quoteReportData != null &&
    expectedReportData === quoteReportData.toLowerCase();

  const checksummedAddress = trySync(() => getAddress(identity.address));
  const recovered = await tryAsync(() =>
    recoverMessageAddress({
      message: `${ATTEST_PREFIX}:${identity.nonce}`,
      signature: identity.nonce_signature as Hex,
    }),
  );
  const sigOk =
    recovered != null &&
    checksummedAddress != null &&
    recovered === checksummedAddress;

  const didAddress = serverInfoDid ? addressFromDid(serverInfoDid) : null;
  const didOk =
    didAddress != null &&
    checksummedAddress != null &&
    didAddress === checksummedAddress;

  const legBinding: LegResult = {
    ok: reportDataOk && sigOk && didOk,
    label: "Identity binding",
    detail: reportDataOk && sigOk && didOk
      ? "The quote is bound to the backend's signing key and server identity."
      : "The quote could not be fully bound to the backend identity.",
    subchecks: [
      {
        ok: reportDataOk,
        label: "report_data binds the signing address + nonce",
        detail: reportDataOk
          ? "The quote body's report_data is sha256(prefix || address || nonce), zero-padded."
          : "The recomputed report_data does not match the quote body.",
      },
      {
        ok: sigOk,
        label: "nonce signature recovers the signing address",
        detail: sigOk
          ? "The EIP-191 nonce signature recovers the bound address."
          : "The nonce signature does not recover the bound address.",
      },
      {
        ok: didOk,
        label: "signing address matches the server-info DID",
        detail: didOk
          ? "The bound address equals the address in the /api/server-info DID."
          : serverInfoDid
            ? "The bound address does not match the server-info DID."
            : "No server-info DID was provided to cross-check.",
      },
    ],
  };

  // ── legCompose: RTMR3 replay + compose-hash event + app_compose binding ──
  const replayed = await tryAsync(() => replayRtmr3(attestation.event_log));
  const rtmr3Ok =
    replayed != null &&
    quoteRtmr3 != null &&
    replayed === quoteRtmr3.replace(/^0x/, "").toLowerCase();

  const composeEvent = trySync(() => extractComposeHashEvent(attestation.event_log));
  const composeEventOk =
    composeEvent != null &&
    typeof info.compose_hash === "string" &&
    composeEvent.toLowerCase() === info.compose_hash.toLowerCase();

  // Fail-honest: app_compose is absent on current prod, so the compose file
  // cannot be hashed and bound. We NEVER fabricate it.
  const hasAppCompose = typeof info.app_compose === "string" && info.app_compose.length > 0;
  let appComposeOk = false;
  let appComposeDetail =
    "The backend does not serve the app-compose file yet, so sha256(app_compose) cannot be bound to compose_hash.";
  if (hasAppCompose) {
    const computed = trySync(() => sha256(toBytes(info.app_compose as string)).slice(2));
    appComposeOk =
      computed != null &&
      typeof info.compose_hash === "string" &&
      computed.toLowerCase() === info.compose_hash.toLowerCase();
    appComposeDetail = appComposeOk
      ? "sha256(app_compose) matches the compose_hash."
      : "sha256(app_compose) does not match the compose_hash.";
  }

  const legCompose: LegResult = {
    ok: rtmr3Ok && composeEventOk && appComposeOk,
    label: "Compose integrity",
    detail: rtmr3Ok && composeEventOk && appComposeOk
      ? "The served event log and app-compose are bound into the quote."
      : "The compose integrity leg is incomplete.",
    subchecks: [
      {
        ok: rtmr3Ok,
        label: "RTMR3 replay matches the quote",
        detail: rtmr3Ok
          ? "Replaying the event log reproduces the quote body's rtmr3."
          : "The event log replay does not reproduce the quote body's rtmr3.",
      },
      {
        ok: composeEventOk,
        label: "compose-hash event matches info.compose_hash",
        detail: composeEventOk
          ? "The compose-hash event payload equals info.compose_hash."
          : "The compose-hash event payload does not match info.compose_hash.",
      },
      {
        ok: appComposeOk,
        label: "sha256(app_compose) matches compose_hash",
        detail: appComposeDetail,
      },
    ],
  };

  return {
    attested: legQuote.ok && legBinding.ok && legCompose.ok,
    legQuote,
    legBinding,
    legCompose,
  };
}
