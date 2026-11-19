import { connectAci } from "@phala/aci-verifier/runtime";
import type { AciConnection, AciReceiptAudit, ConnectAciOptions } from "@phala/aci-verifier/runtime";

export const PRIVATE_RESPONSE_UNVERIFIED_MESSAGE =
  "The model service could not complete this request. Try again later.";
export const STREAMED_RESPONSE_UNVERIFIED_MESSAGE =
  "Couldn't confirm this reply came through the verified enclave. Don't rely on it.";
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

const MAX_VERIFIED_RESPONSE_BYTES = 8 * 1024 * 1024;
export const RECEIPT_AUDIT_TIMEOUT_MS = 5_000;
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

function isDoneFrame(frame: string): boolean {
  return frame.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]";
  });
}
function isReceiptVerificationFrame(frame: string): boolean {
  const lines = frame.split(/\r?\n/);
  if (lines.some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("event:") && trimmed.slice(6).trim() === "tinycloud.receipt-verification";
  })) return true;
  const data = lines
    .filter((line) => line.trimStart().startsWith("data:"))
    .map((line) => line.trimStart().slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  try {
    const value: unknown = JSON.parse(data);
    return !!value && typeof value === "object" && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "receipt_verification");
  } catch {
    return false;
  }
}

async function verifyReceiptWithTimeout(
  aci: AciConnection,
  receiptId: string,
  timeoutMs?: number,
): Promise<AciReceiptAudit> {
  if (timeoutMs === undefined) return aci.verifyReceipt(receiptId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      aci.verifyReceipt(receiptId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RedPillAttestationError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}


function verifiedResponse(response: Response, aci: AciConnection, receiptId: string, signal?: AbortSignal | null, receiptAuditTimeoutMs?: number): Response {
  const reader = response.body?.getReader();
  if (!reader) throw new RedPillAttestationError();
  let size = 0;
  let settled = false;
  let cancelled = false;
  let buffer = "";
  let sawDone = false;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const cleanup = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", cancelOnAbort);
    try { reader.releaseLock(); } catch { /* Keep the terminal stream result. */ }
  };
  const cancelOnAbort = () => { void reader.cancel(signalReason(signal)).catch(() => {}); };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        for (;;) {
          if (signal?.aborted) throw signalReason(signal);
          let separator = buffer.indexOf("\n\n");
          while (separator !== -1) {
            const frame = buffer.slice(0, separator + 2);
            buffer = buffer.slice(separator + 2);
            separator = buffer.indexOf("\n\n");
            if (isDoneFrame(frame)) sawDone = true;
            else if (!sawDone && !isReceiptVerificationFrame(frame)) {
              controller.enqueue(encoder.encode(frame));
              return;
            }
          }
          const chunk = await reader.read();
          if (signal?.aborted) throw signalReason(signal);
          if (!chunk.done) {
            size += chunk.value.byteLength;
            if (size > MAX_VERIFIED_RESPONSE_BYTES) {
              void reader.cancel().catch(() => {});
              throw new RedPillResponseLimitError();
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            continue;
          }
          buffer += decoder.decode();
          if (!sawDone || buffer.trim()) throw new RedPillAttestationError();
          const audit = await verifyReceiptWithTimeout(aci, receiptId, receiptAuditTimeoutMs);
          if (signal?.aborted) throw signalReason(signal);
          if (audit.transcript.verdict.verified !== true) throw new RedPillAttestationError();
          controller.enqueue(encoder.encode(
            `event: tinycloud.receipt-verification\ndata: {"status":"verified"}\n\ndata: [DONE]\n\n`,
          ));
          cleanup();
          controller.close();
          return;
        }
      } catch (error) {
        cleanup();
        if (signal?.aborted) controller.error(signalReason(signal));
        else if (error instanceof RedPillAttestationError || error instanceof RedPillResponseLimitError) controller.error(error);
        else controller.error(new RedPillAttestationError());
      }
    },
    async cancel(reason) {
      cancelled = true;
      signal?.removeEventListener("abort", cancelOnAbort);
      await reader.cancel(reason).catch(() => {});
      cleanup();
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
  receiptAuditTimeoutMs?: number,
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

    if (signal?.aborted) throw signalReason(signal);
    return verifiedResponse(response, aci, receiptId, signal, receiptAuditTimeoutMs);
  };
}

/** Production fetches share one verifier connection per gateway URL and audit timeout. */
export function redPillAciFetch(baseURL: string, receiptAuditTimeoutMs?: number): typeof fetch {
  const cacheKey = receiptAuditTimeoutMs === undefined ? baseURL : `${baseURL}\u0000${receiptAuditTimeoutMs}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = createRedPillAciFetch(baseURL, connectAci, receiptAuditTimeoutMs);
    clients.set(cacheKey, client);
  }
  return client;
}
