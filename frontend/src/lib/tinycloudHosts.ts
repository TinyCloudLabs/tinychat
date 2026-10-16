import { UserFacingError } from "./authErrors";

export const DEFAULT_TINYCLOUD_HOST = "https://node.tinycloud.xyz";
export const FALLBACK_TINYCLOUD_HOST = "https://tee.node.tinycloud.xyz";
export const TINYCLOUD_CONNECTION_MESSAGE =
  "Couldn't connect to TinyCloud. The connection or request limits may have blocked it. The request was not automatically retried. Check your connection or try a smaller upload.";

type FetchTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Fetch exposes CORS-hidden HTTP failures as transport errors too. Only an
// anonymous, bodyless new-session probe may select another host; never replay
// a signed invocation, upload, share or existing session against an alias.
function isConnectivityFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") return false;
    const failure = current as { name?: string; message?: string; cause?: unknown; code?: string };
    if (failure.name === "AbortError" || failure.name === "TimeoutError") return false;
    if (failure.name === "NetworkError") return true;
    if (failure.name === "TypeError" && /^(Failed to fetch|Load failed|fetch failed|NetworkError when attempting to fetch resource\.?|Unable to connect\b)/i.test(failure.message ?? "")) return true;
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(failure.code ?? "")) return true;
    current = failure.cause;
  }
  return false;
}

async function probe(host: string, fetchImpl: FetchTransport): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(`${host.replace(/\/$/, "")}/info`, {
      method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    // The SDK reads and validates /info again when constructing the session.
    // Release this probe's body without buffering or retaining public metadata.
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new UserFacingError(`TinyCloud is unavailable (HTTP ${response.status}). Please try again.`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new UserFacingError("The TinyCloud connection timed out. Please try again.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/** Choose a host before signing a NEW hosted session. Stored/custom hosts do not use this fallback. */
export async function selectNewSessionHosts(
  configuredHost = DEFAULT_TINYCLOUD_HOST,
  fetchImpl: FetchTransport = globalThis.fetch.bind(globalThis),
): Promise<string[]> {
  if (configuredHost !== DEFAULT_TINYCLOUD_HOST && configuredHost !== `${DEFAULT_TINYCLOUD_HOST}/`) return [configuredHost];
  try {
    await probe(configuredHost, fetchImpl);
    return [configuredHost];
  } catch (error) {
    if (!isConnectivityFailure(error)) throw error;
  }
  try {
    await probe(FALLBACK_TINYCLOUD_HOST, fetchImpl);
    return [FALLBACK_TINYCLOUD_HOST];
  } catch (error) {
    if (!isConnectivityFailure(error)) throw error;
    throw new UserFacingError("Couldn't connect to TinyCloud using either hosted endpoint. Check your connection and try again.", { cause: error });
  }
}

/** Preserve request/body identity and HTTP responses. This boundary NEVER retries. */
export function createTinyCloudFetch(fetchImpl: FetchTransport): FetchTransport {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      const signal = init && "signal" in init ? init.signal : input instanceof Request ? input.signal : undefined;
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof UserFacingError || !isConnectivityFailure(error)) throw error;
      let origin: string;
      try {
        origin = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).origin;
      } catch {
        throw error;
      }
      if (origin !== DEFAULT_TINYCLOUD_HOST && origin !== FALLBACK_TINYCLOUD_HOST) throw error;
      throw new UserFacingError(TINYCLOUD_CONNECTION_MESSAGE, { cause: error });
    }
  };
}
