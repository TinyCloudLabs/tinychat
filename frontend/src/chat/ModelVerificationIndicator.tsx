import { useState, type FC } from "react";
import {
  ChevronDownIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { AttestationDetails } from "@/chat/AttestationDetails";
import { isResponseVerifiableModel } from "@/lib/completionStore";
import { useModelVerification } from "@/lib/useModelVerification";
import { isRetryableStatus } from "@/lib/modelVerificationState";

/**
 * Header, model-level (PRE-SEND) attestation indicator for the ACTIVE model —
 * see docs/general-verification-plan.md. It auto-verifies the selected model
 * (one cached probe per model id, via `useModelVerification`) and answers the
 * pre-send question "is this endpoint actually a TEE?" BEFORE any message is
 * sent. Non-blocking: it never gates the composer or the send path.
 *
 * It is deliberately DISTINCT from the per-message badge:
 *  - The best state it can ever reach is "Enclave verified" (TEAL) — endpoint
 *    attestation, never response-binding, because there is no reply to sign yet.
 *    The teal is visually distinct from the per-message GREEN "Response
 *    verified" so the two guarantees are never confused.
 *  - Click expands `<AttestationDetails mr={mr} signature={null} />` — the SAME
 *    leg breakdown as the badge, with no signature leg (model-level = no sig).
 *
 * States: "Verifying…" (spinner) → "Enclave verified" (teal) · "Not verifiable"
 * (grey, no probe, non-TEE) · "Couldn't verify" (grey, graceful on a throw).
 */
export const ModelVerificationIndicator: FC<{ model: string }> = ({ model }) => {
  const { status, mr, verifiedAt, reverify } = useModelVerification(model);
  const [open, setOpen] = useState(false);

  const expandable = status === "verified" && mr != null;
  // ST6 — a negative verdict (error/unverified) is transient; the pill must be
  // clickable to RETRY exactly when it failed, not disabled. Verified expands;
  // a negative reverifies.
  const retryable = isRetryableStatus(status);
  const interactive = expandable || retryable;
  const signable = isResponseVerifiableModel(model);

  const onClick = () => {
    if (expandable) setOpen((v) => !v);
    else if (retryable) reverify();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        disabled={!interactive}
        aria-expanded={expandable ? open : undefined}
        aria-label={retryable ? "Retry model verification" : "Model verification"}
        title={retryable ? "Verification failed — click to retry" : undefined}
        className={pillClass(status, interactive)}
      >
        {status === "verifying" ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        ) : status === "verified" ? (
          <ShieldCheckIcon className="size-3.5" aria-hidden />
        ) : (
          <ShieldQuestionIcon className="size-3.5" aria-hidden />
        )}
        <span>{label(status)}</span>
        {expandable && (
          <ChevronDownIcon
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        )}
      </button>

      {open && expandable && (
        <div className="absolute left-0 z-30 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-2 shadow-lg">
          {/* Model-level = no per-message signature → enclave-only breakdown. */}
          <AttestationDetails mr={mr} signature={null} context="model-level" />

          {/* Signability sub-signal — honest, set BEFORE sending, driven by the
              tier-1 allowlist: will replies actually be individually signable? */}
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
            {signable ? (
              <span className="text-foreground">
                ✓ Responses are individually signed — each reply can be verified
                below.
              </span>
            ) : (
              "Responses are attested at the enclave level, but not individually signed."
            )}
          </p>

          {/* REQUIRED honesty line — attests the ENDPOINT, not any single reply. */}
          <p className="mt-2 border-t border-border/60 px-1 pt-2 text-[10px] leading-relaxed text-muted-foreground">
            Verified: you&apos;re talking to a genuine Intel TDX enclave. This
            attests the endpoint, not any single reply — see each message&apos;s
            badge for per-response proof.
          </p>

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 px-1 pt-2">
            {verifiedAt != null ? (
              <p className="text-[10px] text-muted-foreground">
                Freshly verified {formatVerifiedAt(verifiedAt)}.
              </p>
            ) : (
              <span />
            )}
            {/* Manual re-verify forces a fresh enclave nonce → re-proves
                liveness. Only reachable here while status is "verified" (the
                panel unmounts the moment reverify flips it to "verifying"). */}
            <button
              type="button"
              onClick={() => reverify()}
              className="inline-flex items-center gap-1 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground"
            >
              <RefreshCwIcon className="size-3" aria-hidden />
              Re-verify
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

function label(status: ReturnType<typeof useModelVerification>["status"]): string {
  switch (status) {
    case "verifying":
      return "Verifying…";
    case "verified":
      return "Enclave verified";
    case "unverifiable":
      return "Not verifiable";
    case "unverified":
    case "error":
      return "Couldn't verify";
    default:
      return "Verifying…";
  }
}

function pillClass(
  status: ReturnType<typeof useModelVerification>["status"],
  expandable: boolean,
): string {
  const base =
    "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors";
  if (status === "verified") {
    // DISTINCT TEAL — endpoint attestation, never confused with the per-message
    // GREEN "Response verified".
    return `${base} border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400 ${
      expandable ? "hover:bg-teal-500/15" : ""
    }`;
  }
  // verifying / unverifiable / error — neutral grey, never red, never green.
  return `${base} border-border bg-muted/40 text-muted-foreground ${
    expandable ? "hover:bg-muted" : "cursor-default"
  }`;
}

/** Best-effort short clock label for the freshly-verified hint. */
function formatVerifiedAt(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "just now";
  try {
    return `at ${d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  } catch {
    return "just now";
  }
}
