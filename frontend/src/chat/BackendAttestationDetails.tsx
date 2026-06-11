import type { FC, ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";

import type { BackendSelfAttestation } from "@/lib/backendAttestation";
import type {
  BackendVerdict,
  LegResult,
  SubCheck,
} from "@/lib/backendAttestation/verify";

/**
 * Per-leg breakdown of the BACKEND self-attestation verdict, rendered in the
 * same visual language as the model-level `AttestationDetails` (Leg / TrustTag /
 * Field rows) but reading from the 3-leg `BackendVerdict` the R3 hook produces.
 *
 * The three legs map 1:1 to the verdict:
 *  - Quote validity  — Phala (relayed) OR Automata on-chain DCAP (trustless).
 *  - Identity binding — report_data recompute, nonce-signature recovery, DID match.
 *  - Compose integrity — RTMR3 replay + compose-hash event + the FAIL-HONEST
 *    app_compose sub-check (the backend does not serve the compose file yet, so
 *    that leg is honestly incomplete — never rendered green when it can't bind).
 *
 * Every sub-check renders with a dot reflecting its own `ok`, so a partially
 * passing leg shows exactly which sub-checks hold rather than collapsing to a
 * single verdict. Honesty copy mirrors the existing tier language: this proves
 * endpoint + code identity (relayed vs trustless anchors), not each response byte.
 */
export const BackendAttestationDetails: FC<{
  verdict: BackendVerdict;
  attestation: BackendSelfAttestation | null;
}> = ({ verdict, attestation }) => {
  const appId = attestation?.info?.app_id;
  const links: { label: string; url: string }[] = [
    ...(verdict.legQuote.links ?? []),
    { label: "Phala explorer (proof.t16z.com)", url: "https://proof.t16z.com" },
    ...(appId
      ? [{ label: "Phala trust center", url: `https://trust.phala.com/app/${appId}` }]
      : []),
    { label: "TinyCloud evidences", url: "https://api.tinycloud.chat/evidences/" },
  ];

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[11px] leading-relaxed text-foreground">
      {/* Quote validity — relayed Phala alongside the trustless on-chain anchor. */}
      <LegBlock leg={verdict.legQuote}>
        <SubCheckRow
          check={verdict.legQuote.subchecks[0]}
          tag="via Phala — relayed"
        />
        <SubCheckRow
          check={verdict.legQuote.subchecks[1]}
          tag="trustless — on-chain"
        />
      </LegBlock>

      {/* Identity binding — report_data, nonce signature, server-info DID. */}
      <LegBlock leg={verdict.legBinding} topBorder>
        {verdict.legBinding.subchecks.map((c) => (
          <SubCheckRow key={c.label} check={c} />
        ))}
      </LegBlock>

      {/* Compose integrity — RTMR3 replay + compose-hash event + (fail-honest)
          app_compose. The app_compose sub-check cannot pass against current prod. */}
      <LegBlock leg={verdict.legCompose} topBorder>
        {verdict.legCompose.subchecks.map((c) => (
          <SubCheckRow key={c.label} check={c} />
        ))}
      </LegBlock>

      {/* Identity fields from the served attestation. */}
      {attestation && (
        <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2 text-muted-foreground">
          <Field name="Backend DID" value={attestation.identity.did} />
          {appId && <Field name="App" value={appId} />}
        </div>
      )}

      {/* External anchors — independent places to re-check the same evidence. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
        {links.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            {link.label}
            <ExternalLinkIcon className="size-3" />
          </a>
        ))}
      </div>

      {/* REQUIRED honesty line — same tier language as AttestationDetails. */}
      <p className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
        {verdict.attested ? (
          <>
            All three legs pass: the TDX quote is verified (relayed via Phala and
            anchored trustlessly on-chain), bound to the backend's signing key and
            server identity, and the served code measurement (RTMR3) replays. This
            attests the <span className="font-semibold">endpoint and code identity</span>
            , not each individual response byte.
          </>
        ) : (
          <>
            Backend attestation is{" "}
            <span className="font-semibold">incomplete</span>. The compose leg
            cannot fully bind yet — the backend does not serve the app-compose file,
            so <code className="font-mono text-[10px]">sha256(app_compose)</code> can't
            be checked against the measured compose hash. This proves endpoint and
            code identity (relayed vs trustless anchors), not each response byte.
          </>
        )}
      </p>
    </div>
  );
};

/** A leg header (its own ok dot + label + detail) wrapping its sub-check rows. */
const LegBlock: FC<{
  leg: LegResult;
  topBorder?: boolean;
  children: ReactNode;
}> = ({ leg, topBorder, children }) => (
  <div
    className={`flex flex-col gap-1 ${topBorder ? "border-t border-border/60 pt-2" : ""}`}
  >
    <Leg ok={leg.ok} label={<span className="font-medium">{leg.label}</span>} />
    <p className="pl-3 text-[10px] text-muted-foreground">{leg.detail}</p>
    <div className="flex flex-col gap-1 pl-3">{children}</div>
  </div>
);

/** A single sub-check row with an optional relayed/trustless trust tag. */
const SubCheckRow: FC<{ check: SubCheck; tag?: ReactNode }> = ({ check, tag }) => (
  <Leg
    ok={check.ok}
    label={
      <>
        {check.label}
        {tag ? (
          <>
            {" "}
            <TrustTag>{tag}</TrustTag>
          </>
        ) : null}
        <span className="block text-[10px] text-muted-foreground">
          {check.detail}
        </span>
      </>
    }
  />
);

const Leg: FC<{ ok: boolean; label: ReactNode }> = ({ ok, label }) => (
  <div className="flex items-start gap-1.5">
    <span
      aria-hidden
      className={`mt-1 size-1.5 shrink-0 rounded-full ${
        ok ? "bg-emerald-500" : "bg-destructive"
      }`}
    />
    <span>{label}</span>
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
    <span className="break-all font-mono text-foreground">{value}</span>
  </div>
);
