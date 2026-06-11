/**
 * Shared upstream-relay helper for the forge-proof verification passthroughs
 * (signature / NRAS / Phala TDX). Each of those routes forwards a request to an
 * upstream and relays the response bytes VERBATIM — no server-side verdict, no
 * parsing — so the browser verifies the cryptography itself and the backend
 * cannot tamper undetected.
 *
 * This helper centralizes that pattern and adds an upstream timeout (ST12a):
 * without one, a hung upstream hangs the client request indefinitely. On any
 * fetch failure (including a timeout abort) it returns the standard
 * `502 { error: "upstream_error", message }` shape the routes used before.
 */
import type { Response } from "express";

/** Default upstream timeout — generous enough for slow attestation services. */
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Fetch `url` with `init` (plus an abort-on-timeout signal) and relay the
 * upstream status + content-type + body to `res` verbatim. On failure, respond
 * 502. `label` names the upstream for the 502 message and error log.
 */
export async function relayUpstream(
  res: Response,
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<void> {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.error(`[relay] failed to reach ${label}:`, error);
    res.status(502).json({ error: "upstream_error", message: `Failed to reach ${label}` });
    return;
  }

  try {
    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.type(contentType);
    res.status(upstream.status).send(body);
  } catch (error) {
    console.error(`[relay] failed to read ${label} response:`, error);
    res.status(502).json({ error: "upstream_error", message: `Failed to reach ${label}` });
  }
}
