import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import express, { type NextFunction, type Request, type Response } from "express";
import { load as loadYaml } from "js-yaml";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
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
          replaces: [],
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
          replaces: [],
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
          replaces: [],
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
          replaces: [],
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "delegation_rejected" });
      expect(refusedFixture.rows.size).toBe(0);
    });
  });

  it("rate limits POST accepts to 6 per address per hour and prunes expired window entries", async () => {
    const nowRef = { current: Date.UTC(2026, 10, 22, 17, 0, 0) };
    const fixture = await createRouteFixture({ nowRef });
    const cidOf = fixture.keys.delegate.node.computeDelegationCid.bind(fixture.keys.delegate.node);
    const pairA = await mintPair(fixture.keys.delegate.did, cidOf, { now: nowRef.current });
    const pairB = await mintPair(fixture.keys.delegate.did, cidOf, { now: nowRef.current });
    fixture.setAddress(pairA.address);

    await withServer(fixture.app, async (base) => {
      const headers = {
        authorization: "Bearer valid-session",
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json",
      };
      const idsA = [pairA.secretsGrant, pairA.meetingsGrant].map((grant) => (JSON.parse(grant) as { cid: string }).cid);
      const bodyFor = (replaces: string[]) =>
        JSON.stringify({
          secretsGrant: pairA.secretsGrant,
          meetingsGrant: pairA.meetingsGrant,
          siwe: pairA.siwe,
          signature: pairA.signature,
          replaces,
        });
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${base}/api/connectors/fireflies/delegation`, {
          method: "POST",
          headers,
          body: bodyFor(i === 0 ? [] : idsA),
        });
        expect(res.status).toBe(200);
      }
      const seventh = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "POST", headers, body: bodyFor(idsA) });
      expect(seventh.status).toBe(429);
      expect(await seventh.json()).toEqual({ error: "delegation_rate_limited" });

      // Advance past the 1-hour window: a request from another address prunes expired entries,
      // and address A can accept again.
      nowRef.current += 3_600_001;
      fixture.setAddress(pairB.address);
      const bodyB = JSON.stringify({
        secretsGrant: pairB.secretsGrant,
        meetingsGrant: pairB.meetingsGrant,
        siwe: pairB.siwe,
        signature: pairB.signature,
        replaces: [],
      });
      const resB = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "POST", headers, body: bodyB });
      expect(resB.status).toBe(200);

      fixture.setAddress(pairA.address);
      const resAAfterWindow = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "POST", headers, body: bodyFor(idsA) });
      expect(resAAfterWindow.status).toBe(200);
    });
  });

  it("keeps GET strictly read-only without destroying stored ciphertext on transient CID failure", async () => {
    const nowRef = { current: Date.UTC(2026, 10, 22, 17, 0, 0) };
    const fixture = await createRouteFixture({ nowRef });
    const realCid = fixture.keys.delegate.node.computeDelegationCid.bind(fixture.keys.delegate.node);
    const pair = await mintPair(fixture.keys.delegate.did, realCid, { now: nowRef.current });
    fixture.setAddress(pair.address);

    await withServer(fixture.app, async (base) => {
      const headers = {
        authorization: "Bearer valid-session",
        "x-requested-with": "XMLHttpRequest",
        "content-type": "application/json",
      };
      const postRes = await fetch(`${base}/api/connectors/fireflies/delegation`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          secretsGrant: pair.secretsGrant,
          meetingsGrant: pair.meetingsGrant,
          siwe: pair.siwe,
          signature: pair.signature,
          replaces: [],
        }),
      });
      expect(postRes.status).toBe(200);

      const key = fixture.store.keyFor(pair.address);
      const storedBefore = structuredClone(fixture.rows.get(key));

      // Simulate transient corrupt read via tampered IV on GET: GET must not overwrite KV.
      const originalGet = fixture.rows.get(key);
      fixture.rows.set(key, { ...(originalGet as Record<string, unknown>), iv: "AAAA" });
      const corruptGet = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(corruptGet.status).toBe(200);
      expect(await corruptGet.json()).toEqual({ state: "needs_renewal", expiresAt: null });
      expect((fixture.rows.get(key) as Record<string, unknown>).ciphertext).toBe(
        (storedBefore as Record<string, unknown>).ciphertext,
      );

      // Restore original record: GET returns active again.
      fixture.rows.set(key, storedBefore);
      const recovered = await fetch(`${base}/api/connectors/fireflies/delegation`, { headers });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ state: "active", expiresAt: pair.expiresAt.toISOString() });
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

  it("answers GET, POST and DELETE /api/connectors/fireflies/delegation with 404 and never touches KMS when flag is unset or 'false'", async () => {
    const indexPath = resolve(repoRoot, "backend/src/index.ts");
    const load = createRequire(indexPath);
    const compiledBuild = await Bun.build({
      entrypoints: [indexPath],
      target: "node",
      format: "cjs",
      external: ["*"],
      plugins: [
        {
          name: "fireflies-flag-off-index",
          setup(builder) {
            builder.onLoad({ filter: /\/index\.ts$/ }, async () => ({
              contents:
                (await Bun.file(indexPath).text()).replaceAll(
                  "import.meta.url",
                  JSON.stringify(pathToFileURL(indexPath).href),
                ) + "\nexport { main as runMain };",
              loader: "ts",
            }));
          },
        },
      ],
    });
    expect(compiledBuild.success).toBe(true);
    const compiled = await compiledBuild.outputs[0]!.text();

    const backendPrivateKey = ("0x" + "22".repeat(32)) as `0x${string}`;
    const userAddress = privateKeyToAccount(generatePrivateKey()).address;
    const validBearer = issueSessionToken(userAddress, backendPrivateKey);
    const realAuth = load("./middleware/auth.ts");
    const realBodyParser = load("./body-parsing.ts");
    const realServerPkg = load("@tinyboilerplate/server");
    const realRequestContext = load("./request-context.ts");
    const realCors = load("./cors-origins.ts");
    const realRedpill = load("./redpill-aci.ts");
    const realAgentStream = load("./agent-stream-policy.ts");
    const realTranscripts = load("./transcripts/meeting-rollout.ts");
    const realTranscriptionApi = load("./services/transcription-api.ts");
    const realPrivateCloud = load("./services/private-cloud-transcription.ts");
    const realAssemblyAi = load("./services/assemblyai-hosted.ts");
    const realGoogle = load("./services/google-oauth.ts");
    const realGranola = load("./routes/granola-proxy.ts");
    const realExoMailbox = load("./exo/mailbox.ts");
    const realLocalValidation = load("./local-validation.ts");

    for (const flagValue of [undefined, "false"] as const) {
      let kmsCalls = 0;
      let server: Server | null = null;
      const noop = () => {};
      const emptyRouter = () => express.Router();
      const expressFactory = Object.assign(() => {
        const app = express();
        const origListen = app.listen.bind(app);
        app.listen = ((_opts: unknown, listener?: () => void) => {
          server = origListen(0, "127.0.0.1", listener);
          return server;
        }) as typeof app.listen;
        return app;
      }, express);

      const env: Record<string, string | undefined> = {
        BACKEND_PRIVATE_KEY: backendPrivateKey,
        TINYCLOUD_HOST: HOST,
        FRONTEND_URL: "https://tinycloud.chat",
        DSTACK_SOCKET: "/var/tmp/tc3905-must-not-open-dstack.sock",
        ...(flagValue === undefined ? {} : { FIREFLIES_SERVER_IMPORT_ENABLED: flagValue }),
      };

      const known: Record<string, unknown> = {
        fs: { existsSync: () => false, readFileSync: () => "{}" },
        path: load("node:path"),
        url: load("node:url"),
        express: expressFactory,
        cors: () => (_req: Request, _res: Response, next: NextFunction) => next(),
        "@tinyboilerplate/server": {
          ...realServerPkg,
          DelegationStore: class {},
          DelegationCache: class {},
          createNonceStore: () => ({}),
        },
        "@tinyboilerplate/core": { APP_ID: "xyz.tinycloud.tinychat" },
        "./startup.js": {
          createTinychatBackendIdentity: async () => ({
            node: { kv: { list: async () => ({ data: { keys: [] } }) } },
            did: "did:pkh:eip155:1:0x" + "33".repeat(20),
          }),
        },
        "./attestation/dstackClient.js": {
          createDstackKeyClient: () => {
            kmsCalls++;
            throw new Error("KMS must not be touched when FIREFLIES_SERVER_IMPORT_ENABLED is off");
          },
        },
        "./fireflies-import-identity.js": {
          deriveFirefliesImportKeys: async () => {
            kmsCalls++;
            throw new Error("KMS derivation must not run when FIREFLIES_SERVER_IMPORT_ENABLED is off");
          },
        },
        "./routes/fireflies-delegation.js": { createFirefliesDelegationRouter },
        "./services/fireflies-grant-store.js": {
          createKvFirefliesGrantPort: () => {
            kmsCalls++;
            throw new Error("Grant store must not be built when FIREFLIES_SERVER_IMPORT_ENABLED is off");
          },
          FirefliesGrantStore,
        },
        "./body-parsing.js": realBodyParser,
        "./middleware/auth.js": realAuth,
        "./request-context.js": {
          ...realRequestContext,
          createRequestContextMiddleware: () => realRequestContext.createRequestContextMiddleware(() => {}),
        },
        "./rate-limits.js": {
          applyRateLimiters: () => ({ globalRoutes: { top: () => ({}) }, paidChatLimiter: noop }),
          logGlobalBucketRoutes: noop,
        },
        "./security.js": { applySecurityDefaults: noop },
        "./cors-origins.js": {
          appCorsOptions: () => ({ origin: [] }),
          frontendOriginsFromEnv: realCors.frontendOriginsFromEnv,
        },
        "./local-validation.js": realLocalValidation,
        "./redpill-aci.js": realRedpill,
        "./agent-stream-policy.js": realAgentStream,
        "./transcripts/meeting-rollout.js": realTranscripts,
        "./mcp-meetings/config.js": { mcpChatFromEnv: () => ({}) },
        "./services/transcription-api.js": {
          transcriptDeliveryConfigFromEnv: (e: NodeJS.ProcessEnv) =>
            realTranscriptionApi.transcriptDeliveryConfigFromEnv(e),
          transcriptionApiConfigFromEnv: () => realTranscriptionApi.transcriptionApiConfigFromEnv(env),
          createTranscriptionApiClient: () => ({}),
        },
        "./services/private-cloud-transcription.js": realPrivateCloud,
        "./services/assemblyai-hosted.js": realAssemblyAi,
        "./routes/assemblyai-hosted.js": {
          ASSEMBLYAI_HOSTED_MOUNT: "/api/transcriber/assemblyai/hosted",
          createAssemblyAiHostedRouter: emptyRouter,
          reconcileHostedJobs: async () => {},
        },
        "./routes/private-cloud-transcription.js": {
          createPrivateCloudTranscriptionRouter: emptyRouter,
        },
        "./routes/assemblyai-status.js": { createAssemblyAiStatusRouter: emptyRouter },
        "./bots-service-routes.js": { createBotsServiceGuardRouter: emptyRouter },
        "./services/google-oauth.js": {
          googleMeetOAuthEnabled: () => realGoogle.googleMeetOAuthEnabled(env),
          googleOAuthConfigFromEnv: () => realGoogle.googleOAuthConfigFromEnv(env),
        },
        "./routes/granola-proxy.js": {
          granolaProxyEnabled: () => realGranola.granolaProxyEnabled(env),
          createGranolaProxyRouter: emptyRouter,
        },
        "./exo/mailbox.js": {
          exoCapabilitiesEnabled: (e: NodeJS.ProcessEnv) => realExoMailbox.exoCapabilitiesEnabled(e, () => {}),
        },
        "./exo/stores.js": { createOwnerGrantOpener: () => Object.assign(async () => null, { invalidate: noop }) },
        "./exo/grant-holders.js": {
          GrantHolderIndex: class { async refresh() {} },
          createTrackedGrantStore: (store: unknown) => store,
        },
        "./routes/bots.js": { botsFromEnv: () => undefined, createBotsRouter: emptyRouter },
        "./renewal-verify.js": { renewalVerifyConfigFromEnv: () => undefined },
        "./services/connector-drain.js": {
          ConnectorDrainWorker: class { stop() {} },
          startConnectorQueueMaintenanceTimer: () => ({ stop() {} }),
          createWebhookQueueDirectory: () => async () => [],
          createWebhookPurgeLedgerDirectory: () => async () => [],
          drainIntervalFromEnv: () => 60_000,
        },
        "./routes/route-unavailable.js": load("./routes/route-unavailable.ts"),
        "./routes/connector-webhooks.js": {
          ConnectorControlStore: class {},
          ConnectorWebhookLimiters: class {},
          createConnectorPurgeRouter: emptyRouter,
          createConnectorWebhookCompanionRouter: emptyRouter,
          respondToConnectorPurgeCheck: noop,
          createConnectorWebhookHandler: () => noop,
          createConnectorWebhookParserErrorHandler: () => noop,
          connectorDrainAbort: { aborted: false },
        },
        "./routes/chat.js": { createChatRouter: emptyRouter, defaultModel: "test-model" },
        "./routes/billing-webhook.js": { createBillingWebhookHandler: () => noop },
        "./services/webhook-tokens.js": { assertStrongSecret: noop, WebhookTokenService: class {} },
        "./build-info.js": { readBackendBuildInfo: () => ({ backendRevision: "test", backendVersion: "0.0.0" }) },
        "js-yaml": { load: () => ({}) },
        "@scalar/express-api-reference": { apiReference: emptyRouter },
      };

      const fallback = new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === "__esModule") return false;
            if (typeof key === "string" && key.startsWith("create") && key.endsWith("Router")) return emptyRouter;
            if (typeof key === "string" && /^[a-z]/.test(key)) return noop;
            return class { start() {} stop() { return Promise.resolve(); } };
          },
        },
      );
      const moduleExports = {};
      const context = {
        module: { exports: moduleExports },
        exports: moduleExports,
        Buffer,
        URL,
        Promise,
        setTimeout,
        setInterval: () => ({ unref() {} }),
        process: {
          env,
          argv: [],
          cwd: () => resolve(repoRoot, "backend"),
          on: noop,
          once: noop,
          exit: (code: number) => {
            throw new Error(`unexpected process.exit(${code})`);
          },
        },
        console: { log: noop, warn: noop, error: noop },
        require: (id: string) => (id in known ? known[id] : fallback),
      };

      runInNewContext(compiled, context);
      await (context.module.exports as { runMain: () => Promise<void> }).runMain();
      expect(server).not.toBeNull();
      const listening = server!;
      if (!listening.listening) await once(listening, "listening");

      try {
        const { port } = listening.address() as { port: number };
        const base = `http://127.0.0.1:${port}`;
        const headers = {
          authorization: `Bearer ${validBearer}`,
          "x-requested-with": "XMLHttpRequest",
          "content-type": "application/json",
        };

        const health = await fetch(`${base}/health`);
        expect(health.status).toBe(200);

        const getRes = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "GET", headers });
        expect(getRes.status).toBe(404);

        const postRes = await fetch(`${base}/api/connectors/fireflies/delegation`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        });
        expect(postRes.status).toBe(404);

        const delRes = await fetch(`${base}/api/connectors/fireflies/delegation`, { method: "DELETE", headers });
        expect(delRes.status).toBe(404);

        expect(kmsCalls).toBe(0);
      } finally {
        const closed = once(listening, "close");
        listening.close();
        await closed;
      }
    }
  });
});
