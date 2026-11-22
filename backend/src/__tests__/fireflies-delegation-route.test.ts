import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { load as loadYaml } from "js-yaml";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { makePkhSpaceId, SiweMessage } from "@tinycloud/sdk-core";
import { siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import {
  deriveFirefliesImportKeys,
  FIREFLIES_DELEGATE_KMS_PATH,
} from "../fireflies-import-identity.js";
import {
  FIREFLIES_APPLICATIONS_KV_PREFIX,
  FIREFLIES_DELEGATION_MODE_FACT_KEY,
  FIREFLIES_DELEGATION_MODE_TERMINAL,
  FIREFLIES_SECRET_ENCRYPTION_KEY_PATH,
  FIREFLIES_SECRET_KV_PATH,
} from "../fireflies-import-verify.js";
import { DelegationActivationError } from "../portable-delegation.js";
import { createFirefliesDelegationRouter } from "../routes/fireflies-delegation.js";
import { FirefliesGrantStore, type FirefliesGrantKvPort } from "../services/fireflies-grant-store.js";

const HOST = "https://tee.node.tinycloud.xyz";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const repoRoot = resolve(import.meta.dir, "../../..");

function base58(bytes: Uint8Array): string {
  let num = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function mintPair(
  delegateDid: string,
  computeDelegationCid: (authorization: string) => string,
  options: { now?: number; ttlMs?: number; bareNetwork?: boolean; terminal?: boolean } = {},
) {
  const now = options.now ?? Date.now();
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address;
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const secretsSpaceId = makePkhSpaceId(address, 1, "secrets");
  const appsSpaceId = makePkhSpaceId(address, 1, "applications");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const keyId = `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]))}`;
  const sessionDid = `did:key:${keyId}`;

  const siwe = new SiweMessage({
    domain: "tinycloud.chat",
    address,
    statement: "Sign in to TinyCloud",
    uri: `${sessionDid}#${keyId}`,
    version: "1",
    chainId: 1,
    nonce: randomBytes(12).toString("hex"),
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 30 * 86_400_000).toISOString(),
  }).prepareMessage();
  const signature = await account.signMessage({ message: siwe });
  const proof = computeDelegationCid(
    (siweToDelegationHeaders({ siwe, signature }) as { Authorization: string }).Authorization,
  );
  const expSecs = Math.floor((now + (options.ttlMs ?? 7 * 86_400_000)) / 1000);

  const build = (spaceId: string, att: Record<string, Record<string, unknown[]>>) => {
    const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: rawPub.toString("base64url") }, typ: "JWT", ucv: "0.10.0" };
    const payload: Record<string, unknown> = {
      att,
      aud: delegateDid,
      exp: expSecs,
      iss: `${sessionDid}#${keyId}`,
      nnc: randomBytes(12).toString("hex"),
      prf: [proof],
    };
    if (options.terminal !== false) {
      payload.fct = [{ [FIREFLIES_DELEGATION_MODE_FACT_KEY]: FIREFLIES_DELEGATION_MODE_TERMINAL }];
    }
    const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const authorization = `Bearer ${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    return JSON.stringify({
      cid: computeDelegationCid(authorization),
      delegationHeader: { Authorization: authorization },
      host: HOST,
      spaceId,
      ownerAddress: address,
      chainId: 1,
      delegateDID: delegateDid,
      expiry: new Date(expSecs * 1000).toISOString(),
    });
  };

  const encryptionUri = options.bareNetwork
    ? `urn:tinycloud:encryption:${ownerDid}:default`
    : `urn:tinycloud:encryption:${ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`;

  return {
    address,
    secretsGrant: build(secretsSpaceId, {
      [`${secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
      [encryptionUri]: { "tinycloud.encryption/decrypt": [{}] },
    }),
    meetingsGrant: build(appsSpaceId, {
      [`${appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: { "tinycloud.kv/put": [{}] },
    }),
    siwe,
    signature,
    expiresAt: new Date(expSecs * 1000),
    now,
  };
}

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

async function createRouteFixture(options: {
  sessionAddress?: string;
  activate?: () => Promise<void>;
  nowRef?: { current: number };
} = {}) {
  const keys = await deriveFirefliesImportKeys(
    {
      getKey: async (path) =>
        Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0xb1 : 0xb2),
    },
    { host: HOST, env: {} },
  );
  const rows = new Map<string, unknown>();
  const kv: FirefliesGrantKvPort = {
    async get(key) {
      return (rows.get(key) as never) ?? null;
    },
    async put(key, value) {
      rows.set(key, structuredClone(value));
    },
    async delete(key) {
      rows.delete(key);
    },
  };
  const store = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  const nowRef = options.nowRef ?? { current: Date.now() };
  let activeAddress = options.sessionAddress;

  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== "Bearer valid-session" || !activeAddress) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { address: activeAddress };
    next();
  };

  const app = express();
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  app.use(
    "/api/connectors/fireflies/delegation",
    createFirefliesDelegationRouter({
      delegate: keys.delegate,
      configuredHost: HOST,
      store,
      authMiddleware,
      now: () => nowRef.current,
      activate: options.activate,
    }),
  );

  return {
    app,
    keys,
    store,
    rows,
    nowRef,
    setAddress(addr: string | undefined) {
      activeAddress = addr;
    },
  };
}

describe("POST/GET/DELETE /api/connectors/fireflies/delegation", () => {
  it("enforces Bearer auth and X-Requested-With CSRF on mutating calls", async () => {
    const fixture = await createRouteFixture();
    const cidOf = fixture.keys.delegate.node.computeDelegationCid.bind(fixture.keys.delegate.node);
    const pair = await mintPair(fixture.keys.delegate.did, cidOf);
    fixture.setAddress(pair.address);

    await withServer(fixture.app, async (base) => {
      const noAuth = await fetch(`${base}/api/connectors/fireflies/delegation`);
      expect(noAuth.status).toBe(401);

      const noCsrfPost = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers: { authorization: "Bearer valid-session", "content-type": "application/json" },
        body: JSON.stringify({
          secretsGrant: pair.secretsGrant,
          meetingsGrant: pair.meetingsGrant,
          siwe: pair.siwe,
          signature: pair.signature,
        }),
      });
      expect(noCsrfPost.status).toBe(403);

      const noCsrfDelete = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "DELETE",
        headers: { authorization: "Bearer valid-session" },
      });
      expect(noCsrfDelete.status).toBe(403);
    });
  });

  it("supports GET none -> POST active -> GET active -> needs_renewal / revoked -> DELETE none with content-free responses", async () => {
    const nowRef = { current: Date.UTC(2026, 10, 22, 17, 0, 0) };
    const fixture = await createRouteFixture({ nowRef });
    const cidOf = fixture.keys.delegate.node.computeDelegationCid.bind(fixture.keys.delegate.node);
    const pair = await mintPair(fixture.keys.delegate.did, cidOf, { now: nowRef.current });
    fixture.setAddress(pair.address);

    await withServer(fixture.app, async (base) => {
      const headers = {
        authorization: "Bearer valid-session",
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json",
      };

      const initial = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ state: "none", expiresAt: null });

      const accepted = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          secretsGrant: pair.secretsGrant,
          meetingsGrant: pair.meetingsGrant,
          siwe: pair.siwe,
          signature: pair.signature,
        }),
      });
      expect(accepted.status).toBe(200);
      const acceptedJson = (await accepted.json()) as Record<string, unknown>;
      expect(Object.keys(acceptedJson).sort()).toEqual(["expiresAt", "state"]);
      expect(acceptedJson).toEqual({ state: "active", expiresAt: pair.expiresAt.toISOString() });

      const active = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(active.status).toBe(200);
      const activeJson = (await active.json()) as Record<string, unknown>;
      expect(Object.keys(activeJson).sort()).toEqual(["expiresAt", "state"]);
      expect(activeJson).toEqual({ state: "active", expiresAt: pair.expiresAt.toISOString() });

      // Advance clock past 7d expiry: GET returns needs_renewal and clears ciphertext.
      nowRef.current = pair.expiresAt.getTime() + 1_000;
      const lapsed = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(lapsed.status).toBe(200);
      expect(await lapsed.json()).toEqual({ state: "needs_renewal", expiresAt: pair.expiresAt.toISOString() });

      // Mark revoked: GET returns revoked.
      await fixture.store.markState(pair.address, "revoked", null);
      const revoked = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ state: "revoked", expiresAt: null });

      // DELETE clears record.
      const deleted = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "DELETE",
        headers,
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ state: "none", expiresAt: null });

      const afterDelete = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(afterDelete.status).toBe(200);
      expect(await afterDelete.json()).toEqual({ state: "none", expiresAt: null });
      expect(fixture.rows.size).toBe(0);
    });
  });

  it("rejects bare-network, non-terminal, malformed and node-refused grants without storing", async () => {
    const fixture = await createRouteFixture();
    const cidOf = fixture.keys.delegate.node.computeDelegationCid.bind(fixture.keys.delegate.node);
    const barePair = await mintPair(fixture.keys.delegate.did, cidOf, { bareNetwork: true });
    fixture.setAddress(barePair.address);

    await withServer(fixture.app, async (base) => {
      const headers = {
        authorization: "Bearer valid-session",
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json",
      };

      const bareRes = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          secretsGrant: barePair.secretsGrant,
          meetingsGrant: barePair.meetingsGrant,
          siwe: barePair.siwe,
          signature: barePair.signature,
        }),
      });
      expect(bareRes.status).toBe(400);
      expect(await bareRes.json()).toEqual({ error: "bare_network_decrypt_forbidden" });

      const nonTermPair = await mintPair(fixture.keys.delegate.did, cidOf, { terminal: false });
      fixture.setAddress(nonTermPair.address);
      const nonTermRes = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          secretsGrant: nonTermPair.secretsGrant,
          meetingsGrant: nonTermPair.meetingsGrant,
          siwe: nonTermPair.siwe,
          signature: nonTermPair.signature,
        }),
      });
      expect(nonTermRes.status).toBe(400);
      expect(await nonTermRes.json()).toEqual({ error: "non_terminal_delegation" });

      const badJson = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers,
        body: "{not-json",
      });
      expect(badJson.status).toBe(400);
      expect(await badJson.json()).toEqual({ error: "invalid_body" });
      expect(fixture.rows.size).toBe(0);
    });

    const refusedFixture = await createRouteFixture({
      activate: async () => {
        throw new DelegationActivationError(401, { cause: new Error("revoked"), body: '{"code":"delegation_revoked"}' });
      },
    });
    const refusedCidOf = refusedFixture.keys.delegate.node.computeDelegationCid.bind(refusedFixture.keys.delegate.node);
    const validPair = await mintPair(refusedFixture.keys.delegate.did, refusedCidOf);
    refusedFixture.setAddress(validPair.address);

    await withServer(refusedFixture.app, async (base) => {
      const res = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers: {
          authorization: "Bearer valid-session",
          "x-requested-with": "XMLHttpRequest",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          secretsGrant: validPair.secretsGrant,
          meetingsGrant: validPair.meetingsGrant,
          siwe: validPair.siwe,
          signature: validPair.signature,
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "delegation_rejected" });
      expect(refusedFixture.rows.size).toBe(0);
    });
  });

  it("rate limits POST accepts to 6 per address per hour", async () => {
    const fixture = await createRouteFixture();
    const cidOf = fixture.keys.delegate.node.computeDelegationCid.bind(fixture.keys.delegate.node);
    const pair = await mintPair(fixture.keys.delegate.did, cidOf);
    fixture.setAddress(pair.address);

    await withServer(fixture.app, async (base) => {
      const headers = {
        authorization: "Bearer valid-session",
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json",
      };
      const body = JSON.stringify({
        secretsGrant: pair.secretsGrant,
        meetingsGrant: pair.meetingsGrant,
        siwe: pair.siwe,
        signature: pair.signature,
      });
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "POST", headers, body });
        expect(res.status).toBe(200);
      }
      const seventh = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "POST", headers, body });
      expect(seventh.status).toBe(429);
      expect(await seventh.json()).toEqual({ error: "delegation_rate_limited" });
    });
  });
});

describe("deploy workflow and compose keep Fireflies server import OFF and KMS-only", () => {
  it("defaults FIREFLIES_SERVER_IMPORT_ENABLED to false across deploy workflow, compose and .env examples", () => {
    type DeployStep = { env?: Record<string, unknown>; run?: string };
    type Workflow = { jobs?: { deploy?: { steps?: DeployStep[] } } };
    type Compose = { services?: Record<string, { environment?: Record<string, unknown>; volumes?: string[] }> };

    const workflow = loadYaml(
      readFileSync(resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"), "utf8"),
    ) as Workflow;
    const writer = workflow.jobs?.deploy?.steps?.find(
      (step) => typeof step.run === "string" && step.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
    );
    expect(writer?.env?.FIREFLIES_SERVER_IMPORT_ENABLED).toBe("${{ vars.FIREFLIES_SERVER_IMPORT_ENABLED || 'false' }}");
    expect(writer?.run).toContain('FIREFLIES_SERVER_IMPORT_ENABLED=${FIREFLIES_SERVER_IMPORT_ENABLED:-false}');

    // Neither the delegate private key nor the grant-store KEK may be an env secret in workflow or compose.
    const envKeys = Object.keys(writer?.env ?? {});
    expect(envKeys.filter((k) => /FIREFLIES.*(KEY|KEK|MASTER|SECRET)/i.test(k))).toEqual([]);

    const compose = loadYaml(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")) as Compose;
    const backendService = compose.services?.["tinychat-backend"];
    expect(backendService?.environment?.FIREFLIES_SERVER_IMPORT_ENABLED).toBe("${FIREFLIES_SERVER_IMPORT_ENABLED:-false}");
    expect(backendService?.volumes).toContain("/var/run/dstack.sock:/var/run/dstack.sock:ro");

    const backendEnvExample = readFileSync(resolve(repoRoot, "backend/.env.example"), "utf8");
    expect(backendEnvExample).toContain("FIREFLIES_SERVER_IMPORT_ENABLED=false");
    const rootEnvExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
    expect(rootEnvExample).toContain("FIREFLIES_SERVER_IMPORT_ENABLED=false");
  });

  it("fails closed at boot in index.ts when FIREFLIES_SERVER_IMPORT_ENABLED=true and dstack socket is missing", () => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "src/index.ts"], {
      cwd: resolve(repoRoot, "backend"),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FIREFLIES_SERVER_IMPORT_ENABLED: "true",
        DSTACK_SOCKET: "/var/tmp/tc3905-absent-dstack.sock",
        BACKEND_PRIVATE_KEY: "0x" + "11".repeat(32),
        TINYCLOUD_HOST: HOST,
        FRONTEND_URL: "https://tinycloud.chat",
      },
    });
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("dstack socket is not available");
  });
});
