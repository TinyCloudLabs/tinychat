// TC-3716: a bug report from the One app, signed by the session key, to the feedback service (plan §B1).
//
// The envelope carries the report as an exact JSON string, so the signature covers those bytes with no
// canonical-JSON rules. The session key signs
//   tinycloud-feedback.v1 \n aud \n session_did \n iat \n nonce \n sha256hex(report)
// and the wallet-signed SIWE that delegated to that key goes along as the proof; the service checks the
// SIWE's URI is this session DID, takes the account from the SIWE's signer, then throws the proof away.
// The session's private key never leaves the SDK (signSessionBytes). Signed out, the report goes with no
// proof and no signature, and the service stores it as unverified, with no screenshot.
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { RecentErrorLine, ReportContext } from "./context";
import type { JpegBytes } from "./image";
import { redactForReport } from "./redact";

export const SIGNING_DOMAIN = "tinycloud-feedback.v1";
export const NOTE_MAX_CHARS = 2000;

export interface ReportSigner {
  sessionDid: string;
  siwe: string;
  siweSignature: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** The signed-in session's signer, or null when there is no session to sign with. */
export function signerFromTcw(tcw: Pick<TinyCloudWeb, "session" | "sessionDid" | "signSessionBytes"> | null): ReportSigner | null {
  const session = tcw?.session();
  if (!tcw || !session?.siwe || !session.signature) return null;
  return {
    sessionDid: tcw.sessionDid,
    siwe: session.siwe,
    siweSignature: session.signature,
    sign: (bytes) => tcw.signSessionBytes(bytes),
  };
}

export function signingString(input: { aud: string; sessionDid: string; iat: number; nonce: string; reportSha256: string }): string {
  return [SIGNING_DOMAIN, input.aud, input.sessionDid, String(input.iat), input.nonce, input.reportSha256].join("\n");
}

export interface SendInput {
  /** The feedback service's origin; also the signed audience. */
  origin: string;
  happened: string;
  context: ReportContext;
  recentErrors: RecentErrorLine[];
  /** A JPEG the person left attached, or null. */
  screenshot: JpegBytes | null;
  signer: ReportSigner | null;
  fetch: typeof fetch;
  now: () => number;
}

export type SendOutcome = { kind: "sent" } | { kind: "sent_without_screenshot" } | { kind: "too_many" } | { kind: "failed" };

const encodeBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sendReport(input: SendInput): Promise<SendOutcome> {
  const { origin, signer } = input;
  // Unverified reports can't carry a screenshot (the service gives them no attach token).
  const screenshot = signer ? input.screenshot : null;
  const report = JSON.stringify({
    area: "one-app",
    kind: "bug",
    happened: redactForReport(input.happened).slice(0, NOTE_MAX_CHARS),
    context: input.context,
    recent_errors: input.recentErrors.map((line) => ({ age_s: line.age_s, msg: redactForReport(line.msg) })),
    ...(screenshot ? { screenshot: { sha256: bytesToHex(sha256(screenshot)), bytes: screenshot.length, type: "image/jpeg" } } : {}),
  });
  const iat = Math.floor(input.now() / 1000);
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const envelope: Record<string, unknown> = { v: 1, report, iat, nonce };
  if (signer) {
    const message = signingString({ aud: origin, sessionDid: signer.sessionDid, iat, nonce, reportSha256: bytesToHex(sha256(new TextEncoder().encode(report))) });
    envelope.proof = { siwe: signer.siwe, siwe_signature: signer.siweSignature, session_did: signer.sessionDid };
    envelope.sig = encodeBase64Url(await signer.sign(new TextEncoder().encode(message)));
  }

  let created: { id?: unknown; attach_token?: unknown };
  try {
    const response = await input.fetch(`${origin}/reports/app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (response.status === 429) return { kind: "too_many" };
    if (!response.ok) return { kind: "failed" };
    created = await response.json().catch(() => ({}));
  } catch {
    return { kind: "failed" };
  }
  if (!screenshot) return { kind: "sent" };
  if (typeof created.id !== "string" || typeof created.attach_token !== "string") return { kind: "sent_without_screenshot" };
  try {
    const upload = await input.fetch(`${origin}/reports/${encodeURIComponent(created.id)}/screenshot`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.attach_token}`, "content-type": "image/jpeg" },
      body: screenshot,
    });
    return upload.ok ? { kind: "sent" } : { kind: "sent_without_screenshot" };
  } catch {
    return { kind: "sent_without_screenshot" };
  }
}
