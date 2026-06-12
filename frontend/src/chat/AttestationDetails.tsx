import type { FC, ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";

import type { VerifyModelResult } from "@/lib/vendor/redpill-verifier";
import { isGpuLegFresh, signatureLegLabel } from "@/chat/verification-predicates";

/**
 * Shared per-leg attestation breakdown — the single source of leg-rendering,
 * trust labels, and "only when present" gating, used by BOTH the per-message
 * badge and the model-level enclave indicator.
 *
 * The two surfaces differ only in whether a per-message signature exists:
 *  - `signature` provided + valid → the tier-1 case: render the signature/signer
 *    leg, the NVIDIA GPU leg, and the response-bound honesty line.
 *  - `signature` null → the model-level / tier-2 case: omit the signature leg,
 *    render the provider-policy legs, and the enclave-only honesty line.
 *
 * Every other leg (Phala-TDX, on-chain DCAP, measurements, report-data,
 * manifest) is shown ONLY when its data is present in `mr` — never fabricated.
 */
export const AttestationDetails: FC<{
  mr: VerifyModelResult;
  signature: {
    valid: boolean;
    signer: string | null;
    /** Set when the signature is cryptographically valid but only freshness or
     *  reply-binding failed — labeled "valid — …", not "invalid" (ST8). */
    reason?: "nonce_not_fresh" | "binding_unverifiable";
  } | null;
  /**
   * Relay-binding leg state (plan Phase 3.4). `null` ⇒ no relay frame was
   * captured for this turn (old backend / aborted stream), so the leg is OMITTED
   * — hard constraint 7. When present, `ok` is the `isRelayBound` verdict: the
   * displayed bytes are exactly what the ATTESTED relay forwarded and signed.
   * Purely additive — it never changes the tier (hard constraint 4) and renders
   * on BOTH tiers (teal models get it too — it's model-agnostic).
   */
  relay?: { ok: boolean } | null;
  /**
   * Which surface is rendering this. Only affects the tier-2 honesty line:
   * `"message"` (default) sits under a sent reply, so it can say "the reply
   * above"; `"model-level"` is the pre-send header panel where no reply exists
   * yet, so it phrases the claim about the endpoint instead.
   */
  context?: "message" | "model-level";
}> = ({ mr, signature, relay = null, context = "message" }) => {
  // tier-1 (response-verified) iff a valid per-message signature is present;
  // otherwise the model-level / tier-2 (enclave-attested) case.
  const responseVerified = signature != null && signature.valid;
  const signer = signature?.signer ?? null;

  const { onchain } = mr;
  const gpu = mr.light.gpu;
  // ST9 — a green GPU leg requires BOTH a PASS verdict AND a matching nonce
  // (not replayed evidence), mirroring the TDX leg's freshness gate. A PASS
  // with nonceMatches=false is replayed evidence and must render non-green.
  const gpuVerdictPass = gpu?.verdict === "true" || gpu?.verdict === "PASS";
  const gpuPass = isGpuLegFresh(gpu);
  const hasGpu = mr.hardware.includes("NVIDIA_CC") || gpuVerdictPass;
  const network = onchain?.network ?? "Automata";

  // Real Phala light-mode legs — surfaced ONLY when their data is present in
  // `mr` (never fabricated). The Phala-verifier verdict is relayed through our
  // backend (trusts Phala + our relay); the on-chain DCAP leg is the trustless
  // anchor and is always kept alongside it.
  const tdx = mr.light?.tdx;
  const phalaTdxVerified = tdx?.verified === true;
  const body = tdx?.quote?.body;
  const mrtdShort = body?.mrtd ? `${body.mrtd.slice(0, 10)}…` : null;
  const reportData = mr.light?.reportData;
  const compose = mr.light?.compose;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[11px] leading-relaxed text-foreground">
      {/* Signature leg — present→show (with ok reflecting validity), null→omit.
          A found-but-invalid signature still renders so the mismatch is visible
          rather than silently dropped. */}
      {signature != null && (
        <Leg
          // A cryptographically valid signature that only fails freshness or
          // reply-binding is honestly "valid — …" (the dedicated leg/footer
          // carries the limitation), so its dot is not destructive (ST8). Only a
          // genuine cryptographic failure (no reason) renders the destructive dot.
          ok={
            signature.valid ||
            signature.reason === "nonce_not_fresh" ||
            signature.reason === "binding_unverifiable"
          }
          label={
            <>
              {signatureLegLabel(signature)}{" "}
              — signer:{" "}
              <code className="break-all font-mono text-[10px] text-muted-foreground">
                {signer ?? "—"}
              </code>
            </>
          }
        />
      )}

      {/* Identity — model, provider, hardware. */}
      <div className="flex flex-col gap-0.5 text-muted-foreground">
        <Field name="Model" value={mr.model} />
        <Field name="Provider" value={mr.provider} />
        <Field
          name="Hardware"
          value={mr.hardware.length ? mr.hardware.join(", ") : "—"}
        />
      </div>

      {/* Intel TDX legs — the trustless on-chain DCAP check (Automata) and/or
          Phala's attestation verifier, each shown only when present. Both anchor
          the TDX verdict; the on-chain leg is never dropped in favour of Phala. */}
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
        {/* Phala's attestation-service verdict — relayed through our backend. */}
        {phalaTdxVerified && (
          <Leg
            ok
            label={
              <>
                Intel TDX quote — verified by Phala attestation service{" "}
                <TrustTag>via Phala — relayed</TrustTag>
              </>
            }
          />
        )}

        {/* On-chain DCAP — the trustless anchor; kept whenever present. */}
        {onchain && (
          <Leg
            ok
            label={
              <span className="inline-flex items-center gap-1">
                Intel TDX quote — verified on-chain (Automata DCAP, {network}){" "}
                <TrustTag>trustless — on-chain</TrustTag>
                {onchain.explorer && (
                  <a
                    href={onchain.explorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLinkIcon className="size-3" />
                  </a>
                )}
              </span>
            }
          />
        )}

        {/* Parsed measurements from the Phala-verified quote body. */}
        {body && (
          <Leg
            ok
            label={
              <>
                Measurements —{" "}
                {mrtdShort ? (
                  <>
                    MRTD{" "}
                    <code className="break-all font-mono text-[10px] text-muted-foreground">
                      {mrtdShort}
                    </code>{" "}
                    ·{" "}
                  </>
                ) : null}
                RTMR0..3 present
              </>
            }
          />
        )}

        {/* Report-data binding — only when the verifier produced one. */}
        {reportData && (
          <Leg ok={reportData.bindsAddress} label="Report-data binding" />
        )}

        {/* Freshness — the quote embeds OUR nonce, so it isn't a replayed
            historical quote. Required for the green tier (ST4). */}
        {reportData && (
          <Leg
            ok={reportData.embedsNonce}
            label="Response nonce fresh (not replayed)"
          />
        )}

        {/* Manifest hash matches measured config — absent for e.g. glm-5.1. */}
        {compose && (
          <Leg
            ok={compose.hashMatches}
            label="Manifest hash matches measured config"
          />
        )}

        {/* NVIDIA GPU — an additional attestation, shown ONLY when present (in
            both the per-message and model-level surfaces), consistent with the
            report-data / manifest legs. */}
        {hasGpu && (
          <Leg
            ok={gpuPass}
            label={
              gpu
                ? `NVIDIA GPU attested — verdict: ${gpu.verdict}${gpu.nonceMatches ? ", nonce bound" : ", nonce not fresh"}`
                : "NVIDIA GPU attested"
            }
          />
        )}

        {/* Provider policy — shown ONLY when the verifier actually produced one;
            never fabricated (manifest repo / e2e data may be absent client-side). */}
        {!responseVerified && mr.tinfoil && (
          <Leg
            ok={mr.tinfoil.hwPolicyValid}
            label={
              <>
                Tinfoil hardware policy{" "}
                {mr.tinfoil.hwPolicyValid ? "verified" : "not verified"}
                {mr.tinfoil.manifestValid !== null
                  ? ` · manifest ${mr.tinfoil.manifestValid ? "matched" : "mismatch"}`
                  : ""}
              </>
            }
          />
        )}
        {!responseVerified && mr.chutes && (
          <Leg
            ok={mr.chutes.e2eBindingVerified || mr.chutes.debugModeDisabled}
            label={
              <>
                Chutes policy
                {mr.chutes.debugModeDisabled ? " · debug mode disabled" : ""}
                {mr.chutes.e2eBindingVerified ? " · E2E binding verified" : ""}
              </>
            }
          />
        )}

        {/* Relay-binding leg — present whenever a relay frame was captured, on
            BOTH tiers (model-agnostic). `ok` is the isRelayBound verdict: the
            displayed bytes are exactly what the ATTESTED relay forwarded + signed
            with the key its backend quote binds. Additive — never a tier change. */}
        {relay != null && (
          <Leg
            ok={relay.ok}
            label={
              <>
                Relay signed — reply bound to attested TinyCloud relay{" "}
                <TrustTag>relayed — TEE</TrustTag>
              </>
            }
          />
        )}
      </div>

      {responseVerified && (
        /* Honest claim — names exactly the legs that pass, nothing more. */
        <p className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
          Intel TDX quote verified on-chain (Automata DCAP) · response signature
          valid · reply bound to the enclave · quote fresh
          {gpuPass ? " · NVIDIA GPU attested" : ""}.
        </p>
      )}

      {!responseVerified && context === "model-level" && (
        /* REQUIRED honesty line, pre-send: no reply exists yet, so the claim is
           about the ENDPOINT, not "the reply above". */
        <p className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
          Enclave attestation confirms this endpoint is a genuine Intel TDX
          enclave. Individual responses are{" "}
          <span className="font-semibold">not</span> yet signed — see each
          message badge for per-reply proof.
        </p>
      )}

      {!responseVerified && context === "message" && signature != null && (
        /* Tier-2 with a signature PRESENT (the RedPill gateway-rewrite case): the
           model DID sign, so the old "does not sign individual responses" copy
           would be a contradiction. Explain the actual limitation instead — the
           gateway rewrites the bodies before the enclave signs them, so the
           signed hash can't be reproduced from the reply we render. */
        <p className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
          The model enclave signed this exchange, but the gateway rewrites the
          request/response bodies before signing, so the signed hash can&apos;t be
          reproduced from the reply above — it is{" "}
          <span className="font-semibold">not</span> independently bound to the
          model enclave. The attestation still proves a genuine Intel TDX enclave
          produced it{relay != null ? "; the relay leg above binds the bytes on screen to the attested TinyCloud relay" : ""}.
        </p>
      )}

      {!responseVerified && context === "message" && signature == null && (
        /* Truly-unsigned case — keep the original copy: this model emits no
           per-reply signature at all. */
        <p className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
          This model does not sign individual responses, so the reply above is{" "}
          <span className="font-semibold">not</span> cryptographically bound to
          the enclave. The attestation proves a genuine Intel TDX enclave
          produced it.
        </p>
      )}

      {/* Cross-link — this leg attests the model endpoint; the relay backend that
          brokers the request is attested separately under Settings. */}
      <p className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
        Relay: backend attestation → Settings
      </p>
    </div>
  );
};

const Leg: FC<{ ok: boolean; label: ReactNode; muted?: boolean }> = ({
  ok,
  label,
  muted,
}) => (
  <div className="flex items-start gap-1.5">
    <span
      aria-hidden
      className={`mt-1 size-1.5 shrink-0 rounded-full ${
        muted ? "bg-muted-foreground/40" : ok ? "bg-emerald-500" : "bg-destructive"
      }`}
    />
    <span className={muted ? "text-muted-foreground" : undefined}>{label}</span>
  </div>
);

/** Small inline tag noting WHO a leg's verdict trusts (relayed vs trustless). */
const TrustTag: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
    {children}
  </span>
);

const Field: FC<{ name: string; value: string }> = ({ name, value }) => (
  <div className="flex gap-1.5">
    <span className="shrink-0">{name}:</span>
    <span className="break-all text-foreground">{value}</span>
  </div>
);
