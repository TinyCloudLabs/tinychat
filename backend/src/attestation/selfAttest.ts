import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const BACKEND_ATTESTATION_PREFIX = "tinychat-backend-attest-v1";

export interface DstackQuote {
  quote: string;
  event_log: string;
  report_data?: string;
}

export interface DstackInfo {
  app_id?: string;
  instance_id?: string;
  compose_hash?: string;
  app_compose?: string;
  os_image_hash?: string;
}

export interface DstackClient {
  getQuote(reportDataHex: string): Promise<DstackQuote>;
  info(): Promise<DstackInfo>;
}

export interface BackendSelfAttestation {
  quote: string;
  event_log: string;
  report_data: string;
  identity: {
    did: string;
    address: string;
    nonce: string;
    nonce_signature: Hex;
  };
  info: DstackInfo;
}

export class DstackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DstackUnavailableError";
  }
}

export function createDstackUnavailableError(message: string): DstackUnavailableError {
  return new DstackUnavailableError(message);
}

export function isDstackUnavailableError(error: unknown): error is DstackUnavailableError {
  return error instanceof DstackUnavailableError;
}

export async function buildBackendReportData(address: string, nonce: string): Promise<string> {
  const canonicalAddress = getAddress(address);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${BACKEND_ATTESTATION_PREFIX}${canonicalAddress}${nonce}`),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function selfAttest(input: {
  privateKey: string;
  did: string;
  nonce: string;
  dstack: DstackClient;
}): Promise<BackendSelfAttestation> {
  const account = privateKeyToAccount(input.privateKey as Hex);
  const address = account.address;
  const reportData = await buildBackendReportData(address, input.nonce);
  const quote = await input.dstack.getQuote(reportData);
  const info = await input.dstack.info();
  const nonceSignature = await account.signMessage({
    message: `${BACKEND_ATTESTATION_PREFIX}:${input.nonce}`,
  });

  return {
    quote: quote.quote,
    event_log: quote.event_log,
    report_data: reportData,
    identity: {
      did: input.did,
      address,
      nonce: input.nonce,
      nonce_signature: nonceSignature,
    },
    info,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
