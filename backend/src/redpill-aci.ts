import { connectAci } from "@phala/aci-verifier/runtime";
import type { AciConnection, ConnectAciOptions } from "@phala/aci-verifier/runtime";

export const PRIVATE_RESPONSE_UNVERIFIED_MESSAGE =
  "Couldn't confirm this reply came from the confidential model, so it isn't shown. Try again.";
export const DEFAULT_RED_PILL_BASE_URL = "https://tee.redpill.ai/v1";

export function validateRedPillBaseUrl(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("Invalid confidential model endpoint: expected the attested gateway");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "tee.redpill.ai" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid confidential model endpoint: expected the attested gateway");
  }
  return baseURL;
}

export class RedPillAciError extends Error {
  readonly code = "upstream_failed";
  constructor() {
    super("RedPill's attested connection could not be established.");
    this.name = "RedPillAciError";
  }
}

export class RedPillAttestationError extends Error {
  readonly code = "private_response_unverified";
  constructor() {
    super("RedPill response receipt verification failed.");
    this.name = "RedPillAttestationError";
  }
}

export class RedPillResponseLimitError extends Error {
  readonly code = "result_size_limit";
  constructor() {
    super("Verified response exceeded the configured buffer limit.");
    this.name = "RedPillResponseLimitError";
  }
}

type AciConnector = (options: ConnectAciOptions) => Promise<AciConnection>;

const MAX_BUFFERED_RESPONSE_BYTES = 8 * 1024 * 1024;
const RECEIPT_HISTORY_SIZE = 1000;
const clients = new Map<string, typeof fetch>();

function withVerifiedProvider(init: RequestInit): RequestInit {
  if (typeof init.body !== "string") throw new RedPillAciError();
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    throw new RedPillAciError();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new RedPillAciError();
  const payload = body as Record<string, unknown>;
  const provider = payload.provider;
  if (provider !== undefined && (provider === null || typeof provider !== "object" || Array.isArray(provider))) {
    throw new RedPillAciError();
  }
  return {
    ...init,
    body: JSON.stringify({
      ...payload,
      provider: { ...(provider as Record<string, unknown> | undefined), aci_verified: true },
    }),
  };
}

function signalReason(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function bufferResponse(response: Response, signal?: AbortSignal | null): Promise<Uint8Array[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new RedPillAttestationError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signalReason(signal)).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signalReason(signal);
      const chunk = await reader.read();
      if (signal?.aborted) throw signalReason(signal);
      if (chunk.done) return chunks;
      size += chunk.value.byteLength;
      if (size > MAX_BUFFERED_RESPONSE_BYTES) throw new RedPillResponseLimitError();
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (signal?.aborted) throw signalReason(signal);
    if (error instanceof RedPillResponseLimitError) throw error;
    throw new RedPillAttestationError();
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch { /* Preserve the verification outcome. */ }
  }
}

function replayResponse(chunks: Uint8Array[], response: Response): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** Create one lazily-attested, receipt-verifying fetch for the approved gateway. */
export function createRedPillAciFetch(
  baseURL: string,
  connect: AciConnector = connectAci,
): typeof fetch {
  validateRedPillBaseUrl(baseURL);
  let connectionPromise: Promise<AciConnection> | undefined;
  const connection = (): Promise<AciConnection> => {
    if (connectionPromise) return connectionPromise;
    connectionPromise = connect({
      baseURL,
      serving: { requireVerified: true, requireReceipt: true },
      receiptHistorySize: RECEIPT_HISTORY_SIZE,
    }).then((aci) => {
      if (aci.identity.transcript.verdict.verified !== true) {
        void aci.close();
        throw new RedPillAttestationError();
      }
      return aci;
    }).catch((error: unknown) => {
      connectionPromise = undefined;
      if (error instanceof RedPillAciError || error instanceof RedPillAttestationError) throw error;
      throw new RedPillAciError();
    });
    return connectionPromise;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = withVerifiedProvider(init ?? {});
    const signal = request.signal;
    if (signal?.aborted) throw signalReason(signal);

    let aci: AciConnection;
    try {
      aci = await connection();
    } catch (error) {
      if (signal?.aborted) throw signalReason(signal);
      throw error;
    }

    let response: Response;
    try {
      response = await aci.fetch(input, request);
    } catch (error) {
      if (signal?.aborted) throw signalReason(signal);
      if (error !== null && typeof error === "object" && !Array.isArray(error)
        && "code" in error && error.code === "receipt_missing") {
        throw new RedPillAttestationError();
      }
      throw new RedPillAciError();
    }

    // Error responses contain no model reply; preserve status/body for existing
    // context and provider-error handling without exposing generated content.
    if (!response.ok) return response;
    const receiptId = response.headers.get("x-receipt-id");
    if (!receiptId) {
      void response.body?.cancel();
      throw new RedPillAttestationError();
    }

    const chunks = await bufferResponse(response, signal);
    if (signal?.aborted) throw signalReason(signal);
    try {
      const audit = await aci.verifyReceipt(receiptId);
      if (audit.transcript.verdict.verified !== true) throw new RedPillAttestationError();
    } catch (error) {
      if (signal?.aborted) throw signalReason(signal);
      if (error instanceof RedPillAttestationError) throw error;
      throw new RedPillAttestationError();
    }
    if (signal?.aborted) throw signalReason(signal);
    return replayResponse(chunks, response);
  };
}

/** Production default fetches share one verifier connection per gateway URL. */
export function redPillAciFetch(baseURL: string): typeof fetch {
  let client = clients.get(baseURL);
  if (!client) {
    client = createRedPillAciFetch(baseURL);
    clients.set(baseURL, client);
  }
  return client;
}
