import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { Readable } from "node:stream";

export function validateBotsConnectHost(serviceUrl: string, connectHost: string): void {
  if (new URL(serviceUrl).protocol !== "https:") throw new Error("BOTS_SERVICE_CONNECT_HOST requires HTTPS");
  if (!/^[0-9a-f]{40}-443s\.dstack-[a-z0-9-]+\.phala\.network$/.test(connectHost)) {
    throw new Error("Invalid BOTS_SERVICE_CONNECT_HOST; use the TLS passthrough host");
  }
}

/** Connect through the gateway while authenticating the service's certificate. */
export function botsConnectFetch(serviceUrl: string, connectHost: string): typeof fetch {
  if (new URL(serviceUrl).protocol !== "https:") throw new Error("Bots transport requires HTTPS");
  const identity = new URL(serviceUrl);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== identity.origin) throw new Error("Unexpected bots origin");
    return new Promise<Response>((resolve, reject) => {
      const headers = new Headers(init?.headers);
      headers.set("host", identity.host);
      const req = request({
        hostname: connectHost, port: url.port || 443, servername: connectHost,
        path: url.pathname + url.search, method: init?.method ?? "GET",
        headers: Object.fromEntries(headers), signal: init?.signal ?? undefined,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) => checkServerIdentity(identity.hostname, cert),
      }, res => {
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status: res.statusCode!, headers: res.headers as Record<string, string>,
        }));
      });
      req.on("error", reject);
      req.end(init?.body);
    });
  }) as typeof fetch;
}
