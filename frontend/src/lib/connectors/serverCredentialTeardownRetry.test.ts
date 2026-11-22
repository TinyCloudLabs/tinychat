// TC-2778: an owner whose backend has no credential route. The real webhooks client talks over
// loopback HTTP to the backend's marked 404 and reads it as feature-dark: no DELETE is sent and
// the owner's in-memory credential, content, queue and Exo state stay as they were.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { SessionStore } from "@tinyboilerplate/client";
import type createExpressApp from "express";
import type { Express as App } from "express";

import type { PurgeLedger } from "../../../../backend/src/routes/connector-webhooks.js";
import { credentialRouteUnavailable } from "../../../../backend/src/routes/route-unavailable.js";
import {
  CREDENTIAL_MASTER_ENV,
  CredentialStore,
  InMemoryCredentialRowStore,
  _resetCredentialMasterCache,
} from "../../../../backend/src/services/credential-store.js";
import { createConnectorWebhooksClient } from "./webhooksApi";

const backendRequire = createRequire(new URL("../../../../backend/package.json", import.meta.url));
const express = backendRequire("express") as typeof createExpressApp;

const SOURCE = "fireflies";
const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const CREDENTIAL_MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const ORIGINAL_ENV = { ...process.env };

const sessionStore = { getToken: () => "session-token", isExpired: () => false } as unknown as SessionStore;

beforeEach(() => {
  _resetCredentialMasterCache();
  process.env[CREDENTIAL_MASTER_ENV] = CREDENTIAL_MASTER;
  process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT = "1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetCredentialMasterCache();
});

interface Backend {
  credentials: CredentialStore;
  content: Map<string, string[]>;
  queue: Map<string, number>;
  ledgers: Map<string, PurgeLedger>;
  exo: Set<string>;
  failNextPurge: boolean;
  disabled: number;
  requests: string[];
}

function backend(): Backend {
  return {
    credentials: new CredentialStore(new InMemoryCredentialRowStore(), { upstreamRevoker: async () => {} }),
    content: new Map(),
    queue: new Map(),
    ledgers: new Map(),
    exo: new Set(),
    failNextPurge: false,
    disabled: 0,
    requests: [],
  };
}

const key = (source: string, address: string) => `${source} ${address.toLowerCase()}`;

async function serve(b: Backend, mount: (app: App) => void): Promise<{ base: string; server: Server }> {
  const app = express();
  app.use(express.json(), (req, _res, next) => {
    b.requests.push(req.method);
    Object.assign(req, { user: { address: ADDRESS } });
    next();
  });
  mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

async function withServer<T>(
  b: Backend,
  mount: (app: App) => void,
  action: (base: string) => Promise<T>,
): Promise<T> {
  const { base, server } = await serve(b, mount);
  try {
    return await action(base);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
  }
}

async function seedConnectedOwner(b: Backend): Promise<void> {
  await b.credentials.store({ source: SOURCE, address: ADDRESS, secret: { kind: "oauth", accessToken: "ff-token" } });
  b.content.set(key(SOURCE, ADDRESS), ["mtg-1", "mtg-2"]);
  b.queue.set(key(SOURCE, ADDRESS), 3);
  b.exo.add(key(SOURCE, ADDRESS));
}

describe("an owner the backend does not handle", () => {
  const shapes: Array<[string, (b: Backend) => (app: App) => void]> = [
    ["route not mounted", () => (app) => app.use("/api/connectors/credentials", (_req, res) => credentialRouteUnavailable(res))],
  ];

  for (const [name, mount] of shapes) {
    test(`${name}: feature-dark, no DELETE, nothing torn down`, async () => {
      const b = backend();
      await seedConnectedOwner(b);

      const result = await withServer(b, mount(b), (base) =>
        createConnectorWebhooksClient(base, { sessionStore }).teardownCredential!(SOURCE),
      );

      expect(result).toEqual({ status: "feature-dark" });
      expect(b.requests).toEqual(["GET"]);
      expect(b.disabled).toBe(0);
      expect(await b.credentials.status(SOURCE, ADDRESS)).not.toBeNull();
      expect(b.content.get(key(SOURCE, ADDRESS))).toEqual(["mtg-1", "mtg-2"]);
    });
  }
});
