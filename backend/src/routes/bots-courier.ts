import express, { Router, type RequestHandler, type Response } from "express";
import { botOwnerDid, botsServiceHeaders, type BotsConfig } from "./bots.js";
import { mountCourierPairing } from "./bots-courier-pairing.js";
import { mountCourierThreads } from "./bots-courier-threads.js";

export interface CourierRouterDeps {
  config: BotsConfig;
  auth: RequestHandler;
  callBots(address: string, method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<globalThis.Response>;
}

interface CourierRouterOptions {
  config?: BotsConfig;
  auth: RequestHandler;
  enabled?: boolean;
}

interface PermissionEntry {
  service: "tinycloud.kv" | "tinycloud.hooks";
  space: "agents";
  path: string;
  actions: string[];
}

const isExpiry = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const unavailable = (res: Response) => res.status(503).json({ error: "courier_unavailable" });

/** The service owns the manifest; only its public permission fields cross this boundary. */
function publicPermissions(value: unknown): PermissionEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const permissions: PermissionEntry[] = [];
  for (const candidate of value) {
    const entry: unknown = candidate;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !("service" in entry) || !("space" in entry) || entry.space !== "agents"
      || !("path" in entry) || typeof entry.path !== "string" || entry.path.length > 512
      || !("actions" in entry) || !Array.isArray(entry.actions) || entry.actions.length === 0 || entry.actions.length > 8) return undefined;
    const { service, path, actions } = entry;
    if (service !== "tinycloud.kv" && service !== "tinycloud.hooks") return undefined;
    if (service === "tinycloud.kv" ? !path.startsWith("xyz.tinycloud.courier/") : path !== "kv/xyz.tinycloud.courier/") return undefined;
    const allowed = service === "tinycloud.kv" ? ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list", "tinycloud.kv/del", "tinycloud.kv/metadata"] : ["tinycloud.hooks/subscribe"];
    const publicActions: string[] = [];
    for (const action of actions) {
      if (typeof action !== "string" || !allowed.includes(action)) return undefined;
      publicActions.push(action);
    }
    permissions.push({ service, space: "agents", path, actions: publicActions });
  }
  return permissions;
}

function publicIdentity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("did" in value)
    || typeof value.did !== "string" || !value.did.startsWith("did:key:") || value.did.length > 512
    || !("publicJwk" in value) || !("request" in value)) return undefined;
  const { publicJwk, request } = value;
  if (!publicJwk || typeof publicJwk !== "object" || Array.isArray(publicJwk)
    || !("kty" in publicJwk) || publicJwk.kty !== "OKP" || !("crv" in publicJwk) || publicJwk.crv !== "Ed25519"
    || !("x" in publicJwk) || typeof publicJwk.x !== "string" || publicJwk.x.length === 0 || publicJwk.x.length > 128) return undefined;
  if (!request || typeof request !== "object" || Array.isArray(request)
    || !("host" in request) || request.host !== "https://node.tinycloud.xyz"
    || !("expiry" in request) || request.expiry !== "30d" || !("permissions" in request)) return undefined;
  const permissions = publicPermissions(request.permissions);
  if (!permissions) return undefined;
  return {
    did: value.did,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x },
    request: { permissions, host: "https://node.tinycloud.xyz", expiry: "30d" },
  };
}

function expiryMetadata(value: unknown, nullable: boolean) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("expiresAt" in value)
    || !(isExpiry(value.expiresAt) || (nullable && value.expiresAt === null))) return undefined;
  return { expiresAt: value.expiresAt };
}

export function createBotsCourierRouter({ config, auth, enabled = process.env.BOTS_COURIER_ENABLED === "true" }: CourierRouterOptions) {
  const router = Router();
  if (!enabled || !config) {
    router.use((_req, res) => { res.status(404).end(); });
    return router;
  }
  router.use(auth);
  router.use((req, res, next) => {
    if (!req.user || !config.accountAllowed(req.user.address)) { res.status(404).end(); return; }
    next();
  });

  const deps: CourierRouterDeps = {
    config,
    auth,
    async callBots(address, method, path, value) {
      const url = `${config.serviceUrl}/v1/bots/main${path}`;
      const body = value === undefined ? undefined : JSON.stringify(value);
      return (config.fetchImpl ?? fetch)(url, {
        method,
        headers: botsServiceHeaders(config, botOwnerDid(address), method, url, body),
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(10_000),
      });
    },
  };

  router.get("/identity", async (req, res) => {
    try {
      const response = await deps.callBots(req.user!.address, "GET", "/courier/identity");
      if (!response.ok) { unavailable(res); return; }
      const identity = publicIdentity(await response.json());
      if (!identity) { unavailable(res); return; }
      res.json(identity);
    } catch { unavailable(res); }
  });
  router.get("/grant", async (req, res) => {
    try {
      const response = await deps.callBots(req.user!.address, "GET", "/courier/grant");
      if (!response.ok) { unavailable(res); return; }
      const metadata = expiryMetadata(await response.json(), true);
      if (!metadata) { unavailable(res); return; }
      res.json(metadata);
    } catch { unavailable(res); }
  });
  router.put("/grant", express.json({ limit: "96kb" }), async (req, res) => {
    const input: unknown = req.body;
    if (!input || typeof input !== "object" || Array.isArray(input) || !("raw" in input)
      || !Object.hasOwn(input, "raw") || input.raw === undefined || !("expiresAt" in input) || !isExpiry(input.expiresAt)) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    try {
      const response = await deps.callBots(req.user!.address, "PUT", "/courier/grant", { raw: input.raw, expiresAt: input.expiresAt });
      if (response.status === 400) { res.status(400).json({ error: "invalid_grant" }); return; }
      if (!response.ok) { unavailable(res); return; }
      const metadata = expiryMetadata(await response.json(), false);
      if (!metadata) { unavailable(res); return; }
      res.json(metadata);
    } catch { unavailable(res); }
  });
  router.delete("/grant", async (req, res) => {
    try {
      const response = await deps.callBots(req.user!.address, "DELETE", "/courier/grant");
      if (!response.ok) { unavailable(res); return; }
      res.status(204).end();
    } catch { unavailable(res); }
  });

  // courier: pairing mount
  mountCourierPairing(router, deps);
  // courier: threads mount
  mountCourierThreads(router, deps);
  return router;
}
