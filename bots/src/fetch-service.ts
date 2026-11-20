// The page-reading process's one route: POST /fetch {"url", "hosts"} -> {"ok": true, "url", "text"} or
// {"ok": false, "reason"}. It is on a private link network that only the gateway shares, holds no key, and applies the
// guard (fetch-guard.ts) itself whoever asks: `hosts` is the owner's site list (null: any public site), applied to the
// address and to every redirect. It returns plain text, never markup (page-text.ts).

import { fetchGuarded, type GuardDeps, type GuardLimits, LIMITS } from "./fetch-guard";
import { isRecord } from "./guards";
import { pageText } from "./page-text";
import { readableAddress } from "./web";
import { hostListed, listedHost, MAX_HOSTS } from "./web-policy";

/** Plain text handed back is cut here; the gateway cuts again for the model. */
export const MAX_REPLY_CHARS = 100_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_IN_FLIGHT = 8;

export interface FetchServiceOptions {
  guard: GuardDeps;
  limits?: GuardLimits;
  maxInFlight?: number;
}

const reply = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

export function fetchService(options: FetchServiceOptions): (req: Request) => Promise<Response> {
  let inFlight = 0;
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  return async req => {
    if (new URL(req.url).pathname !== "/fetch") return reply({ ok: false, reason: "not_found" }, 404);
    if (req.method !== "POST") return reply({ ok: false, reason: "method" }, 405);
    // The server itself stops a larger body (maxRequestBodySize in fetch-main.ts); this is the same bound in the route.
    if (Number(req.headers.get("content-length") ?? "0") > MAX_REQUEST_BYTES) return reply({ ok: false, reason: "request" }, 400);
    let input: unknown;
    try {
      const raw = await req.text();
      if (raw.length > MAX_REQUEST_BYTES) return reply({ ok: false, reason: "request" }, 400);
      input = JSON.parse(raw);
    } catch {
      return reply({ ok: false, reason: "request" }, 400);
    }
    if (!isRecord(input) || typeof input.url !== "string") return reply({ ok: false, reason: "request" }, 400);
    let allowed: ((host: string) => boolean) | null = null;
    if (input.hosts !== null) {
      const hosts = Array.isArray(input.hosts) && input.hosts.length <= MAX_HOSTS ? input.hosts.map(listedHost) : undefined;
      if (!hosts || hosts.some(host => host === undefined)) return reply({ ok: false, reason: "request" }, 400);
      const policy = { mode: "listed" as const, hosts: hosts as string[] };
      allowed = host => hostListed(policy, host);
    }
    if (inFlight >= maxInFlight) return reply({ ok: false, reason: "busy" }, 503);
    inFlight++;
    try {
      const page = await fetchGuarded(input.url, allowed, options.guard, options.limits ?? LIMITS);
      if (!page.ok) return reply({ ok: false, reason: page.reason });
      const text = (await pageText(page.body, page.contentType, page.url, page.declared)).slice(0, MAX_REPLY_CHARS);
      return reply({ ok: true, url: readableAddress(page.url.href)?.href ?? page.url.href, text });
    } catch {
      return reply({ ok: false, reason: "network" });
    } finally {
      inFlight--;
    }
  };
}
