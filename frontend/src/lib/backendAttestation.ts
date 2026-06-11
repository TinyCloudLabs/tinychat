import type { SessionStore } from "@tinyboilerplate/client";

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

export interface BackendSelfAttestation {
  quote: string;
  event_log: string;
  report_data: string;
  identity: {
    did: string;
    address: string;
    nonce: string;
    nonce_signature: string;
  };
  info: {
    app_id?: string;
    instance_id?: string;
    compose_hash?: string;
    app_compose?: string;
    os_image_hash?: string;
  };
}

export type BackendAttestationClientResult =
  | { status: "available"; attestation: BackendSelfAttestation }
  | { status: "unavailable"; message: string }
  | { status: "unauthenticated"; message: string }
  | { status: "error"; message: string };

export function createBackendAttestationNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchBackendSelfAttestation(input: {
  backendUrl: string;
  sessionStore: SessionStore;
  nonce?: string;
}): Promise<BackendAttestationClientResult> {
  const token = input.sessionStore.getToken();
  if (!token || input.sessionStore.isExpired()) {
    if (token && input.sessionStore.isExpired()) input.sessionStore.clear();
    return { status: "unauthenticated", message: "Session expired. Please sign in again." };
  }

  const nonce = input.nonce ?? createBackendAttestationNonce();
  try {
    const response = await fetch(
      `${input.backendUrl}/api/attestation/self?nonce=${encodeURIComponent(nonce)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
        },
      },
    );

    if (response.status === 503) {
      const body = await response.json().catch(() => null);
      return {
        status: "unavailable",
        message:
          typeof body?.message === "string"
            ? body.message
            : "Backend attestation is unavailable in this environment.",
      };
    }
    if (response.status === 401) {
      input.sessionStore.clear();
      return { status: "unauthenticated", message: "Session expired. Please sign in again." };
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return {
        status: "error",
        message:
          typeof body?.message === "string"
            ? body.message
            : `Backend attestation failed (${response.status}).`,
      };
    }

    return {
      status: "available",
      attestation: (await response.json()) as BackendSelfAttestation,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Backend attestation failed.",
    };
  }
}
