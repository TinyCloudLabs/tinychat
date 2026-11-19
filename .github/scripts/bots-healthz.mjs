#!/usr/bin/env node
// One health probe of the bots service, the way the backend reaches it (backend/src/bots-transport.ts): connect to
// the CVM's TLS-passthrough host on the Phala gateway, with that host as SNI, and accept only a certificate valid for
// the service's own domain. The public name does not route through the gateway (TC-3056), so it is not used here.
//
//   node .github/scripts/bots-healthz.mjs <connect-host> <service-domain>
//
// Exits 0 only on HTTP 200 with the body "ok" (the service's own /healthz answer). Prints one line either way.
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";

const CONNECT_HOST = /^[0-9a-f]{40}-443s\.dstack-[a-z0-9-]+\.phala\.network$/;

export function probe(connectHost, domain, { port = 443, timeoutMs = 15_000 } = {}) {
  if (!CONNECT_HOST.test(connectHost)) return Promise.resolve({ ok: false, detail: `not a TLS passthrough host: ${connectHost}` });
  return new Promise((resolve) => {
    const req = request({
      hostname: connectHost, port, servername: connectHost, path: "/healthz", method: "GET",
      headers: { host: domain }, timeout: timeoutMs, rejectUnauthorized: true,
      checkServerIdentity: (_host, cert) => checkServerIdentity(domain, cert),
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (body.length < 200) body += chunk; });
      res.on("end", () => resolve({
        ok: res.statusCode === 200 && body.trim() === "ok",
        detail: `status=${res.statusCode} body=${JSON.stringify(body.slice(0, 100))}`,
      }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error) => resolve({ ok: false, detail: `${error.code ?? "error"}: ${error.message}` }));
    req.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [connectHost, domain] = process.argv.slice(2);
  if (!connectHost || !domain) {
    console.error("usage: bots-healthz.mjs <connect-host> <service-domain>");
    process.exit(2);
  }
  const result = await probe(connectHost, domain);
  console.log(result.detail);
  process.exit(result.ok ? 0 : 1);
}
