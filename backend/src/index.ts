import "./types/index.js";

import { existsSync, readFileSync } from "fs";
import { createServer as createHttpsServer } from "https";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { apiReference } from "@scalar/express-api-reference";
import { load as loadYaml } from "js-yaml";
import {
  DelegationCache,
  DelegationStore,
  createCsrfMiddleware,
  createNonceStore,
} from "@tinyboilerplate/server";
import { applySecurityDefaults } from "./security.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createDelegationMiddleware } from "./middleware/delegation.js";
import { createAuthRouter } from "./routes/auth.js";
import { createDelegationRouter } from "./routes/delegations.js";
import { createManifestRouter } from "./routes/manifest.js";
import { createChatRouter } from "./routes/chat.js";
import { createSignatureRouter } from "./routes/signature.js";
import { createNrasProxyRouter } from "./routes/nras-proxy.js";
import { createPhalaVerifyRouter } from "./routes/phala-verify.js";
import { createServerInfoRouter } from "./routes/server-info.js";
import { createBillingRouter } from "./routes/billing.js";
import { createBillingWebhookHandler } from "./routes/billing-webhook.js";
import { APP_ID } from "./manifest.js";
import { createTinychatBackendIdentity } from "./startup.js";

const BACKEND_PRIVATE_KEY = process.env.BACKEND_PRIVATE_KEY;
const TINYCLOUD_HOST = process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz";
const PORT = Number.parseInt(process.env.PORT ?? "3014", 10);
const DEFAULT_HTTPS_CERT_FILE = "../frontend/localhost.pem";
const DEFAULT_HTTPS_KEY_FILE = "../frontend/localhost-key.pem";
const hasDefaultTlsFiles =
  existsSync(resolve(process.cwd(), DEFAULT_HTTPS_CERT_FILE)) &&
  existsSync(resolve(process.cwd(), DEFAULT_HTTPS_KEY_FILE));
const HTTPS_CERT_FILE =
  process.env.HTTPS_CERT_FILE ?? (hasDefaultTlsFiles ? DEFAULT_HTTPS_CERT_FILE : undefined);
const HTTPS_KEY_FILE =
  process.env.HTTPS_KEY_FILE ?? (hasDefaultTlsFiles ? DEFAULT_HTTPS_KEY_FILE : undefined);
const FRONTEND_URL =
  process.env.FRONTEND_URL ??
  (HTTPS_CERT_FILE && HTTPS_KEY_FILE ? "https://localhost:5186" : "http://localhost:5186");

if (!BACKEND_PRIVATE_KEY) {
  console.error(
    "BACKEND_PRIVATE_KEY is required. Generate one from the repo root with `bun run generate-key`.",
  );
  process.exit(1);
}
const backendPrivateKey = BACKEND_PRIVATE_KEY;

async function main() {
  const { node, did } = await createTinychatBackendIdentity({
    privateKey: backendPrivateKey,
    host: TINYCLOUD_HOST,
  });
  const delegationStore = new DelegationStore(node);
  const delegationCache = new DelegationCache();
  const nonceStore = createNonceStore();
  const authMiddleware = createAuthMiddleware(backendPrivateKey);
  const _delegationMiddleware = createDelegationMiddleware({
    node,
    store: delegationStore,
    cache: delegationCache,
    backendDid: did,
  });

  const app = express();
  applySecurityDefaults(app);
  app.use(cors({ origin: FRONTEND_URL }));

  // Stripe webhook MUST be mounted before the JSON body parser and CSRF
  // middleware: it needs the raw request bytes for signature verification, and
  // Stripe's servers do not send the X-Requested-With CSRF header.
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    createBillingWebhookHandler(),
  );

  // GPU attestation evidence forwarded to NRAS is large, so the nras-proxy
  // route needs a roomier body limit than the global 64 KB. Registered here,
  // before the global parser, so it applies to that mount specifically.
  app.use("/api/nras-proxy", express.json({ limit: "4mb" }));

  // The Phala TDX-verify passthrough carries a hex quote (a few KB); give it
  // headroom over the global 64 KB parser. Registered before the global parser
  // so it applies to that mount specifically (like the nras-proxy mount above).
  app.use("/api/phala-verify", express.json({ limit: "256kb" }));

  app.use(express.json({ limit: "64kb" }));
  app.use(createCsrfMiddleware());
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, app: APP_ID });
  });
  app.use("/api/manifest", createManifestRouter());
  app.use("/api/server-info", createServerInfoRouter(did));
  app.use(
    "/api/auth",
    createAuthRouter({
      nonceStore,
      privateKey: backendPrivateKey,
    }),
  );
  app.use(
    "/api/delegations",
    createDelegationRouter({
      node,
      backendDid: did,
      store: delegationStore,
      cache: delegationCache,
      authMiddleware,
    }),
  );
  app.use("/api/chat", authMiddleware, createChatRouter());
  app.use("/api/signature", authMiddleware, createSignatureRouter());
  app.use("/api/nras-proxy", authMiddleware, createNrasProxyRouter());
  app.use("/api/phala-verify", authMiddleware, createPhalaVerifyRouter());
  app.use("/api/billing", createBillingRouter({ authMiddleware }));

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const spec = loadYaml(readFileSync(resolve(__dirname, "../openapi.yaml"), "utf-8")) as object;
  app.get("/api/openapi.json", (_req, res) => res.json(spec));
  app.use("/api/docs", apiReference({ spec: { content: spec } }));

  const tlsConfig = loadTlsConfig();
  const server = tlsConfig
    ? createHttpsServer(tlsConfig, app).listen(PORT, () => {
        console.log(`TinyChat backend ready: https://localhost:${PORT}`);
      })
    : app.listen(PORT, () => {
        console.log(`TinyChat backend ready: http://localhost:${PORT}`);
      });

  const shutdown = (signal: string) => {
    console.log(`${signal} received. Shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function loadTlsConfig() {
  if (!HTTPS_CERT_FILE && !HTTPS_KEY_FILE) return null;
  if (!HTTPS_CERT_FILE || !HTTPS_KEY_FILE) {
    throw new Error("Both HTTPS_CERT_FILE and HTTPS_KEY_FILE are required to enable HTTPS.");
  }
  const certFile = resolve(process.cwd(), HTTPS_CERT_FILE);
  const keyFile = resolve(process.cwd(), HTTPS_KEY_FILE);
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    throw new Error(`HTTPS certificate files were not found: ${certFile}, ${keyFile}`);
  }
  return {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  };
}

main().catch((error) => {
  console.error("Failed to start TinyChat backend:", error);
  process.exit(1);
});
