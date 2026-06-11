import { useEffect, useState, type FC } from "react";
import { useMessage } from "@assistant-ui/react";
import { recoverMessageAddress, type Hex } from "viem";
import {
  ChevronDownIcon,
  Loader2Icon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { sha256, verifyModel, type VerifyModelResult } from "@/lib/vendor/redpill-verifier";
import { fetchSignatureProxy } from "@/lib/signatureClient";
import { getCachedModelVerification } from "@/lib/useModelVerification";
import { AttestationDetails } from "@/chat/AttestationDetails";
import {
  assembleSignatureState,
  computeTier,
  isEnclaveBound,
  isFresh,
  isQuoteVerified,
  parseResponseHash,
  type Tier,
} from "@/chat/verification-predicates";
import {
  getCompletion,
  isResponseVerifiableModel,
  isTeeCapableModel,
  onCompletion,
  type CompletionRef,
} from "@/lib/completionStore";

/**
 * Per-assistant-message verification badge, tiered honestly by the STRENGTH of
 * the guarantee (see docs/two-tier-verification-plan.md). The verdict is
 * composed HERE, at the badge layer, over two vendored primitives that verify
 * trustlessly in a browser and never mandate a signature:
 *
 *  - `verifyModel({ model })` — attestation for ANY TEE model (no apiKey, no
 *    signature, no crash). We read `mr.onchain` (the Intel TDX quote checked
 *    on-chain via Automata DCAP), NOT `mr.verified` (driven by the CORS-blocked
 *    Phala-API `checkTdxQuote`, always false in-browser).
 *  - `fetchSignatureProxy()` — the per-message ECDSA signature, fetched through
 *    our backend passthrough. Only flat/NearAI models carry one; it returns
 *    `null` (never throws) for Tinfoil/Chutes models that don't sign replies.
 *
 * Three tiers result:
 *   1. on-chain TDX + valid signature → "Response verified" (green) — the reply
 *      itself is cryptographically bound to a genuine enclave.
 *   2. on-chain TDX only             → "Enclave attested" (sky, NOT green) — a
 *      genuine TDX enclave is proven, but the reply is NOT bound to it.
 *   0. neither                       → "Not verifiable" (grey).
 *
 * It deliberately does NOT use the vendored `verify()` (which mandates a
 * signature and throws on Tinfoil/Chutes), and never surfaces
 * responseHashMatch / requestHashMatch / model_name comparisons.
 *
 * Bound to the message id like `ReceiptFooter`: it renders nothing until the
 * streamed completion id for this turn lands in the session store, then offers
 * to verify on demand (verification is several network round-trips, so it is
 * user-triggered — never auto-run, never on the reply path).
 */
export const ModelVerificationBadge: FC = () => {
  const messageId = useMessage((m) => m.id);
  // The text rendered on screen for THIS assistant message — hashed and compared
  // to the signed response hash so green proves the signature binds the reply we
  // actually show (ST2). Mirrors `messageText` in runtime.tsx.
  const renderedText = useMessage((m) =>
    m.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  );
  const [ref, setRef] = useState<CompletionRef | undefined>(() =>
    getCompletion(messageId),
  );
  useEffect(() => {
    // Re-check on mount in case the ref landed between render and effect.
    setRef(getCompletion(messageId));
    return onCompletion((id, r) => {
      if (id === messageId) setRef(r);
    });
  }, [messageId]);

  if (!ref) return null;
  return (
    <VerificationBadge
      completionId={ref.completionId}
      model={ref.model}
      renderedText={renderedText}
    />
  );
};

type Phase = "idle" | "pending" | "done" | "error";

/** Signature leg sub-state passed to AttestationDetails (ST8). `null` means no
 *  signature was fetched (omit the leg entirely). */
export type SignatureState = {
  valid: boolean;
  signer: string | null;
  /** Set when the signature is self-consistent + reply-bound but only freshness
   *  failed — labeled "Signature valid — nonce not fresh", NOT "invalid". */
  reason?: "nonce_not_fresh";
} | null;

/** What the badge resolved after a verifyModel + signature run. */
interface Verdict {
  tier: Tier;
  mr: VerifyModelResult;
  /** Signature leg state, or null when no signature was fetched. */
  signature: SignatureState;
  signingAddress: string | null;
}

const VerificationBadge: FC<{
  completionId: string;
  model: string;
  renderedText: string;
}> = ({ completionId, model, renderedText }) => {
  const signable = isResponseVerifiableModel(model);
  const teeCapable = isTeeCapableModel(model);
  const [phase, setPhase] = useState<Phase>("idle");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [open, setOpen] = useState(false);

  // A per-message badge only makes sense where there is a per-MESSAGE proof — the
  // per-reply signature, which only signable (flat/NearAI) models produce. For
  // every other model the guarantee is model-level, not per-reply, and lives in the
  // header "Enclave verified" / "Not verifiable" indicator; stamping it under every
  // bubble is redundant and over-implies a per-reply binding that isn't there.
  if (!signable) {
    // Tier 2 — a genuine TEE model that does NOT sign individual replies. Point to
    // the model-level indicator rather than attesting each message (the attestation
    // is identical for every reply and bound to none of them).
    if (teeCapable) {
      return (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70"
          title="This model runs in a TEE but does not sign individual responses. Verify the enclave via the 'Enclave verified' indicator in the header."
        >
          <ShieldCheckIcon className="size-3 text-sky-500/60" />
          Enclave-attested model — verify the endpoint above ↑
        </span>
      );
    }
    // Tier 0 — non-TEE. No per-message badge at all; the header indicator already
    // shows "Not verifiable" for the endpoint.
    return null;
  }

  const runVerify = async () => {
    if (phase === "pending") return;
    setPhase("pending");
    try {
      // 1. Attestation — works for every TEE model, no apiKey, no signature.
      // Reuse the model-level indicator's cached verdict when it already holds a
      // fresh enclave-verified `mr` for this model (design point 5: avoids a
      // redundant probe per message). Falls back to a fresh probe on a miss.
      const mr = getCachedModelVerification(model) ?? (await verifyModel({ model }));

      // 2. Per-message signature — only flat/NearAI models carry one. The proxy
      // returns null (never throws) for Tinfoil/Chutes, leaving them tier ≤ 2.
      const sig = await fetchSignatureProxy(completionId, model);
      let signer: string | null = null;
      let replyBound = false;
      let signatureMalformed = false;
      if (sig) {
        // ST7 — a present-but-malformed signature (truncated / format change)
        // throws in viem's recoverMessageAddress. That MUST NOT discard the
        // already-proven enclave attestation: wrap only the signature leg, and
        // on a throw treat the signature as invalid (signer null, replyBound
        // false) while still computing the tier from the resolved `mr` (which
        // still yields enclave-attested / sky). The OUTER catch then fires only
        // for a thrown verifyModel/attestation failure (true tier-0).
        try {
          signer = await recoverMessageAddress({
            message: sig.text,
            signature: sig.signature as Hex,
          });
          // ST2 — the signed response hash must equal the hash of the text we
          // actually render. Same algorithm/encoding as the vendored sha256 so a
          // genuine match is never falsely rejected.
          const respHashServer = parseResponseHash(sig.text);
          const renderedHash = await sha256(renderedText);
          replyBound = respHashServer != null && renderedHash === respHashServer;
        } catch {
          signer = null;
          replyBound = false;
          signatureMalformed = true;
        }
      }
      const signingAddress = sig?.signing_address ?? null;

      // 3. Compose the honest tier. Green requires a verified TDX quote AND the
      // signing key bound to the enclave (ST1) AND the reply bound to the
      // signature (ST2) AND a fresh, non-replayed quote (ST4). Anything less is
      // sky/grey — never a silent upgrade.
      const quoteVerified = isQuoteVerified(mr);
      const enclaveBound = isEnclaveBound(mr, signer, signingAddress);
      const fresh = isFresh(mr);
      const tier = computeTier({ quoteVerified, enclaveBound, replyBound, fresh });

      // ST8 — only attach a signature leg when a signature was actually fetched
      // (sig != null). Distinguish a fully-bound (green) signature from one that
      // is self-consistent + reply-bound but only fails freshness, from a
      // genuinely invalid one — instead of conflating the latter two as "invalid".
      const signature: SignatureState = assembleSignatureState({
        hasSignature: sig != null,
        signer,
        tier,
        signatureMalformed,
        enclaveBound,
        replyBound,
        fresh,
      });

      setVerdict({ tier, mr, signature, signingAddress });
      setPhase("done");
      setOpen(true);
    } catch {
      // A thrown verifyModel (provider/upstream down) is an honest "Not
      // verifiable", never an alarming raw error.
      setVerdict(null);
      setPhase("error");
      setOpen(true);
    }
  };

  const tier: Tier =
    phase === "done" && verdict ? verdict.tier : "not-verifiable";
  const hasDetails = phase === "done" && tier !== "not-verifiable";

  const onPrimaryClick = () => {
    if (phase === "done" || phase === "error") setOpen((v) => !v);
    else void runVerify();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onPrimaryClick}
        className={primaryPillClass(phase, tier)}
        aria-expanded={phase === "done" || phase === "error" ? open : undefined}
      >
        {phase === "pending" ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : tier === "not-verifiable" ? (
          <ShieldQuestionIcon className="size-3.5" />
        ) : (
          <ShieldCheckIcon className="size-3.5" />
        )}
        <span>{primaryLabel(phase, tier)}</span>
        {(phase === "done" || phase === "error") && (
          <ChevronDownIcon
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open && (phase === "error" || (phase === "done" && !hasDetails)) && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          This response couldn&apos;t be verified — the model didn&apos;t return a
          verifiable on-chain attestation. Confidential models that publish an
          Intel TDX quote (e.g.{" "}
          <code className="font-mono text-[10px]">phala/gpt-oss-120b</code>) can
          be verified here.
        </div>
      )}

      {open && hasDetails && verdict && (
        <AttestationDetails mr={verdict.mr} signature={verdict.signature} />
      )}
    </div>
  );
};

function primaryLabel(phase: Phase, tier: Tier): string {
  if (phase === "idle") return "Verify response";
  if (phase === "pending") return "Verifying…";
  // A thrown / empty verifyModel is an honest "Not verifiable", never a failure.
  if (phase === "error") return "Not verifiable";
  if (tier === "response-verified") return "Response verified";
  if (tier === "enclave-attested") return "Enclave attested";
  return "Not verifiable";
}

function primaryPillClass(phase: Phase, tier: Tier): string {
  const base =
    "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors";
  if (phase === "done" && tier === "response-verified") {
    // Tier 1 — green ONLY for a signature-bound reply.
    return `${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400`;
  }
  if (phase === "done" && tier === "enclave-attested") {
    // Tier 2 — sky/indigo, visually DISTINCT from tier-1 green: a genuine
    // enclave is attested, but the reply is not cryptographically bound to it.
    return `${base} border-sky-500/30 bg-sky-500/10 text-sky-600 hover:bg-sky-500/15 dark:text-sky-400`;
  }
  // idle / pending / error / tier-0 — neutral grey, never red.
  return `${base} border-border bg-muted/40 text-muted-foreground hover:bg-muted`;
}
