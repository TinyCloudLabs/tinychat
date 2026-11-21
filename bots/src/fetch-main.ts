// Page-reading process. Holds no key and no state: one route, POST /fetch, on the private link network it shares only
// with the gateway; its outbound network is a separate bridge. Every dial goes through the guard (fetch-guard.ts).

import { fetchService } from "./fetch-service";
import { networkDeps } from "./fetch-net";

const port = Number(process.env.BOTS_FETCH_PORT ?? "8080");
const server = Bun.serve({ port, hostname: "0.0.0.0", maxRequestBodySize: 16 * 1024, fetch: fetchService({ guard: networkDeps }) });
console.log(JSON.stringify({ fetch: "listening", port: server.port }));
