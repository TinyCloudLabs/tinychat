import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";

import {
  CREDENTIAL_MASTER_ENV,
  CredentialStore,
  InMemoryCredentialRowStore,
  validateCredentialCustodyConfig,
  type CredentialRow,
  type CredentialRowStore,
  type CredentialSecret,
} from "../services/credential-store.js";
import {
  createPkcePair,
  refreshOAuthCredentialIfExpiring,
} from "../services/fireflies-oauth.js";
import {
  createConnectorCredentialRouter,
  type ConnectorOAuthPort,
} from "../routes/connector-credentials.js";
import type { IngestMode } from "../services/ingest-mode.js";

/**
 * W2 — credential store + custody flows (backend-ingest plan §6, §8.1 W2; §8.2 delta item 3;
 * §9 anti-pattern 3).
 *
 * Every test tagged `[delta-03]` is an acceptance test for delta row 3: *per-user credential
 * storage: isolated, encrypted-at-rest, rotation, tenant-scoped retrieval*. The row's own
 * acceptance sentence is the checklist:
 *
 *   `getCredential` for A's address never returns B's; raw store bytes contain no plaintext
 *   credential (grep the dump); rotate replaces + audits; revoke deletes + (OAuth) calls
 *   upstream revoke; no credential substring in any captured log.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const CREDENTIAL_MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const WEBHOOK_MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

/** The exact strings that must never reach a log line, a client, or the substrate in the clear. */
const SECRET_A = "ff-access-token-AAAA-1111";
const REFRESH_A = "ff-refresh-token-AAAA-2222";
const SECRET_B = "ff-access-token-BBBB-3333";

function oauthSecret(accessToken: string, refreshToken?: string): CredentialSecret {
  return {
    kind: "oauth",
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

class FakeOAuth implements ConnectorOAuthPort {
  readonly calls: string[] = [];
  revokeFails = false;
  exchangeFails = false;

  authorizeUrl(input: { state: string; challenge: string; source: string }): string {
    return (
      `https://api.fireflies.ai/authorize?client_id=cid&response_type=code` +
      `&state=${input.state}&code_challenge=${input.challenge}&code_challenge_method=S256`
    );
  }

  async exchangeCode(input: {
    code: string;
    verifier: string;
    source: string;
  }): Promise<CredentialSecret> {
    this.calls.push(`exchange:${input.code}:${input.verifier}`);
    if (this.exchangeFails) throw new Error("upstream token endpoint 500");
    return oauthSecret(SECRET_A, REFRESH_A);
  }

  async revoke(_secret: CredentialSecret): Promise<void> {
    this.calls.push("revoke");
    if (this.revokeFails) throw new Error("upstream revoke 500");
  }
}

interface RouteHarness {
  app: express.Express;
  rows: InMemoryCredentialRowStore;
  credentials: CredentialStore;
  oauth: FakeOAuth;
  cohort: Set<string>;
}

function routeHarness(options: { address?: string } = {}): RouteHarness {
  const rows = new InMemoryCredentialRowStore();
  const oauth = new FakeOAuth();
  const credentials = new CredentialStore(rows, {
    upstreamRevoker: (secret) => oauth.revoke(secret),
  });
  const cohort = new Set<string>([ADDRESS_A]);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.user = { address: options.address ?? ADDRESS_A };
    next();
  });
  app.use(
    "/api/connectors/credentials",
    createConnectorCredentialRouter({
      credentials,
      oauth,
      modes: {
        mode: async (address: string): Promise<IngestMode> =>
          cohort.has(address.toLowerCase()) ? "backend" : "browser",
      },
    }),
  );

  return { app, rows, credentials, oauth, cohort };
}

async function withServer<T>(
  app: express.Express,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve_) => {
    const instance = app.listen(0, () => resolve_(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve_, reject) =>
      server.close((error) => (error ? reject(error) : resolve_())),
    );
  }
}

async function call(
  base: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed as any, text };
}

beforeEach(() => {
  process.env[CREDENTIAL_MASTER_ENV] = CREDENTIAL_MASTER;
  process.env.WEBHOOK_HMAC_MASTER = WEBHOOK_MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── The dedicated master (§6.2) ──────────────────────────────────────

describe("credential custody master", () => {
  test("[delta-03] refuses to boot on a missing, weak or WEBHOOK_HMAC_MASTER-reusing credential master", () => {
    const ok = validateCredentialCustodyConfig({
      [CREDENTIAL_MASTER_ENV]: CREDENTIAL_MASTER,
      WEBHOOK_HMAC_MASTER: WEBHOOK_MASTER,
    } as NodeJS.ProcessEnv);
    expect(ok.ok).toBe(true);

    for (const value of [undefined, "", "   ", "changeme", "ab".repeat(31)]) {
      const result = validateCredentialCustodyConfig({
        ...(value === undefined ? {} : { [CREDENTIAL_MASTER_ENV]: value }),
        WEBHOOK_HMAC_MASTER: WEBHOOK_MASTER,
      } as NodeJS.ProcessEnv);
      expect({ value, ok: result.ok }).toEqual({ value, ok: false });
    }

    // SEPARATE from the HMAC master, per §6.2 — one compromised key must not be both.
    const reused = validateCredentialCustodyConfig({
      [CREDENTIAL_MASTER_ENV]: WEBHOOK_MASTER,
      WEBHOOK_HMAC_MASTER: WEBHOOK_MASTER,
    } as NodeJS.ProcessEnv);
    expect(reused.ok).toBe(false);
    if (!reused.ok) {
      expect(reused.error).not.toContain(WEBHOOK_MASTER);
      expect(reused.error).not.toContain(WEBHOOK_MASTER.slice(0, 8));
    }
  });
});

// ── Store / retrieve / rotate / revoke (§6.2, delta 3) ───────────────

describe("CredentialStore", () => {
  test("[delta-03] getCredential for A's address never returns B's", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows);

    await store.store({ source: SOURCE, address: ADDRESS_A, secret: oauthSecret(SECRET_A) });
    await store.store({ source: SOURCE, address: ADDRESS_B, secret: oauthSecret(SECRET_B) });

    const a = await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker");
    const b = await store.getCredential(SOURCE, ADDRESS_B, "fetch-worker");
    expect(a).toEqual(oauthSecret(SECRET_A));
    expect(b).toEqual(oauthSecret(SECRET_B));

    // Address casing is not a second tenant.
    expect(
      await store.getCredential(SOURCE, ADDRESS_A.toUpperCase().replace("0X", "0x"), "fetch-worker"),
    ).toEqual(oauthSecret(SECRET_A));

    // An address with no credential is null, never a neighbour's.
    expect(
      await store.getCredential(SOURCE, "0xcccccc0000000000000000000000000000000001", "fetch-worker"),
    ).toBeNull();
    // A different source under the SAME address is a different row.
    expect(await store.getCredential("granola", ADDRESS_A, "fetch-worker")).toBeNull();
  });

  test("[delta-03] a row moved into another tenant's slot fails closed — it never decrypts as theirs", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows);
    await store.store({ source: SOURCE, address: ADDRESS_A, secret: oauthSecret(SECRET_A) });

    const stolen = (await rows.read(SOURCE, ADDRESS_A)) as CredentialRow;
    await rows.write({ ...stolen, address: ADDRESS_B });

    // The envelope is bound to (source, address): B cannot read A's ciphertext by relabelling it.
    await expect(store.getCredential(SOURCE, ADDRESS_B, "fetch-worker")).rejects.toThrow();
  });

  test("[delta-03] raw store bytes contain no plaintext credential", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows);
    await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A, REFRESH_A),
    });

    const dump = rows.dump();
    expect(dump.length).toBeGreaterThan(0);
    for (const needle of [SECRET_A, REFRESH_A, SECRET_A.slice(0, 8), REFRESH_A.slice(0, 8)]) {
      expect(dump.includes(needle)).toBe(false);
    }
    // The envelope is present and the DEK is wrapped, not stored bare.
    const row = (await rows.read(SOURCE, ADDRESS_A)) as CredentialRow;
    expect(typeof row.ciphertext).toBe("string");
    expect(typeof row.wrappedDEK).toBe("string");
    expect(row.ciphertext).not.toContain(SECRET_A);
  });

  test("[delta-03] rotate replaces the credential and audits rotatedAt", async () => {
    let clock = 1_000_000;
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, { now: () => clock });

    const created = await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A),
    });
    clock += 60_000;
    const rotated = await store.rotate({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret("ff-access-token-AAAA-rotated"),
    });

    expect(await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker")).toEqual(
      oauthSecret("ff-access-token-AAAA-rotated"),
    );
    expect(rotated.createdAt).toBe(created.createdAt);
    expect(rotated.rotatedAt).not.toBe(created.rotatedAt);
    expect(Date.parse(rotated.rotatedAt)).toBeGreaterThan(Date.parse(created.rotatedAt));
    // No second row is left behind holding the old value.
    const dump = rows.dump();
    expect(dump.includes(SECRET_A)).toBe(false);
  });

  test("[delta-03] revoke deletes the row and calls the upstream OAuth revoke", async () => {
    const rows = new InMemoryCredentialRowStore();
    const revoked: CredentialSecret[] = [];
    const store = new CredentialStore(rows, {
      upstreamRevoker: async (secret) => {
        revoked.push(secret);
      },
    });
    await store.store({ source: SOURCE, address: ADDRESS_A, secret: oauthSecret(SECRET_A) });

    const result = await store.revoke(SOURCE, ADDRESS_A);

    expect(result.deleted).toBe(true);
    expect(result.upstreamRevoked).toBe("ok");
    expect(revoked).toHaveLength(1);
    expect(await rows.read(SOURCE, ADDRESS_A)).toBeNull();
    expect(await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker")).toBeNull();
    expect(rows.dump().includes(SECRET_A)).toBe(false);
  });

  test("[delta-03] a row already marked revokedAt STILL gets its upstream revoke attempt", async () => {
    // `getCredential` reports a soft-revoked row as "not connected" — correct for the read path,
    // wrong for teardown, which is the one caller that needs the token precisely because the row
    // holds the only copy that can revoke it. Reading null there skipped the upstream call and
    // then answered 200 `upstreamRevoked:false`: the provider-side grant stays live, unsignalled.
    const rows = new InMemoryCredentialRowStore();
    const revoked: CredentialSecret[] = [];
    const store = new CredentialStore(rows, {
      upstreamRevoker: async (secret) => {
        revoked.push(secret);
      },
    });
    await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A),
    });
    const row = await rows.read(SOURCE, ADDRESS_A);
    expect(row).not.toBeNull();
    await rows.write({
      ...(row as NonNullable<typeof row>),
      revokedAt: new Date("2026-08-09T00:00:00.000Z").toISOString(),
    });

    const result = await store.revoke(SOURCE, ADDRESS_A);

    expect(revoked).toHaveLength(1);
    expect(result.upstreamRevoked).toBe("ok");
    expect(result.deleted).toBe(true);
    expect(await rows.read(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-03] a teardown that cannot open the envelope reports FAILED, not a clean disconnect", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, {
      upstreamRevoker: async () => undefined,
    });
    await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A),
    });
    const row = await rows.read(SOURCE, ADDRESS_A);
    await rows.write({
      ...(row as NonNullable<typeof row>),
      ciphertext: "not-a-sealed-envelope",
    });

    const result = await store.revoke(SOURCE, ADDRESS_A);

    // Custody still ends locally, but the caller learns the upstream grant was NOT revoked (502).
    expect(result.deleted).toBe(true);
    expect(result.upstreamRevoked).toBe("failed");
    expect(result.reason).toBe("credential_unreadable");
  });

  test("[delta-03] an upstream revoke failure is surfaced, never swallowed — and custody still ends", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, {
      upstreamRevoker: async () => {
        throw new Error("upstream revoke 500");
      },
    });
    await store.store({ source: SOURCE, address: ADDRESS_A, secret: oauthSecret(SECRET_A) });

    const result = await store.revoke(SOURCE, ADDRESS_A);

    expect(result.upstreamRevoked).toBe("failed");
    expect(result.deleted).toBe(true);
    expect(await rows.read(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-03] an api_key credential disconnect answers upstream=not_applicable, never 502", async () => {
    // Security-audit regression: the shipped revoker throws `credential is not revocable` for
    // api_key, and the previous code caught that as `upstream=failed` — so every api_key teardown
    // answered 502 upstream_revoke_failed. §6.2 already models `not_applicable`; the api_key
    // branch must reach it directly instead of via a swallowed throw.
    const rows = new InMemoryCredentialRowStore();
    const revoked: CredentialSecret[] = [];
    const store = new CredentialStore(rows, {
      upstreamRevoker: async (secret) => {
        // Mirrors fireflies-oauth.ts revoke(): api_key throws, oauth succeeds.
        if (secret.kind !== "oauth") throw new Error("credential is not revocable");
        revoked.push(secret);
      },
    });
    await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: { kind: "api_key", apiKey: "ff-api-key-value" },
    });

    const result = await store.revoke(SOURCE, ADDRESS_A);

    expect(result.deleted).toBe(true);
    expect(result.upstreamRevoked).toBe("not_applicable");
    expect(result.reason).toBeUndefined();
    // The revoker was NEVER called with an api_key — the kind check runs first.
    expect(revoked).toHaveLength(0);
    expect(await rows.read(SOURCE, ADDRESS_A)).toBeNull();
  });

  test("[delta-03] CONNECTOR_CREDENTIAL_MASTER_PREV lets an envelope written under the old master still decrypt", async () => {
    // Security-audit regression: currentCredentialMaster reads only CREDENTIAL_MASTER, so rotating
    // the env throws `envelope is unreadable` on every getCredential/revoke — a disconnect cannot
    // revoke upstream, the fetch worker cannot open its credential. Mirror the HMAC master's
    // dual-read grace: writes use current, reads try current then previous.
    const rows = new InMemoryCredentialRowStore();
    const OLD_MASTER = "OLDoldOLDoldOLDoldOLDoldOLDoldOLDoldOLDoldOA=";
    const NEW_MASTER = "NEWnewNEWnewNEWnewNEWnewNEWnewNEWnewNEWnewNA=";

    // 1. Write an envelope under the OLD master.
    const oldStore = new CredentialStore(rows, { master: () => OLD_MASTER });
    await oldStore.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A, REFRESH_A),
    });

    // 2. After rotation, only the current master is `NEW_MASTER`; no grace → decrypt fails.
    const rotatedNoGrace = new CredentialStore(rows, {
      master: () => NEW_MASTER,
      previousMaster: () => null,
    });
    await expect(
      rotatedNoGrace.getCredential(SOURCE, ADDRESS_A, "fetch-worker"),
    ).rejects.toThrow(/envelope is unreadable/);

    // 3. With the grace master wired, the old envelope opens and reads back its plaintext.
    let revokedSeen: CredentialSecret | null = null;
    const rotatedWithGrace = new CredentialStore(rows, {
      master: () => NEW_MASTER,
      previousMaster: () => OLD_MASTER,
      upstreamRevoker: async (secret) => {
        revokedSeen = secret;
      },
    });
    const secret = await rotatedWithGrace.getCredential(
      SOURCE,
      ADDRESS_A,
      "fetch-worker",
    );
    expect(secret?.kind).toBe("oauth");
    if (secret?.kind === "oauth") {
      expect(secret.accessToken).toBe(SECRET_A);
      expect(secret.refreshToken).toBe(REFRESH_A);
    }

    // 4. revoke() must ALSO be able to read the old envelope so the upstream call still fires.
    const result = await rotatedWithGrace.revoke(SOURCE, ADDRESS_A);
    expect(result.upstreamRevoked).toBe("ok");
    expect(revokedSeen).not.toBeNull();
  });

  test("[delta-03] a store write that fails is a FAILURE — never a reported success", async () => {
    const failing: CredentialRowStore = {
      read: async () => null,
      write: async () => {
        throw new Error("substrate write refused");
      },
      remove: async () => {
        throw new Error("substrate delete refused");
      },
    };
    const store = new CredentialStore(failing);

    await expect(
      store.store({ source: SOURCE, address: ADDRESS_A, secret: oauthSecret(SECRET_A) }),
    ).rejects.toThrow();
    await expect(store.revoke(SOURCE, ADDRESS_A)).rejects.toThrow();
  });

  test("[delta-03] no credential substring appears in any captured log, on any path", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, {
      upstreamRevoker: async () => {
        throw new Error(`upstream rejected token ${SECRET_A}`);
      },
    });

    const capture = captureLogs();
    try {
      await store.store({
        source: SOURCE,
        address: ADDRESS_A,
        secret: oauthSecret(SECRET_A, REFRESH_A),
      });
      await store.rotate({ source: SOURCE, address: ADDRESS_A, secret: oauthSecret(SECRET_B) });
      await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker");
      await store.markUsed(SOURCE, ADDRESS_A);
      await store.revoke(SOURCE, ADDRESS_A);
      // The error path too: an unreadable envelope must report a reason, not a value.
      await rows.write({
        source: SOURCE,
        address: ADDRESS_A,
        kind: "oauth",
        ciphertext: "not-base64-envelope",
        wrappedDEK: "also-not",
        createdAt: new Date().toISOString(),
        rotatedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker").catch(() => undefined);
    } finally {
      capture.restore();
    }

    const joined = capture.lines.join("\n");
    expect(capture.lines.length).toBeGreaterThan(0);
    for (const needle of [SECRET_A, SECRET_B, REFRESH_A, SECRET_A.slice(0, 10)]) {
      expect(joined.includes(needle)).toBe(false);
    }
    // Addresses are hashed on the audit lines, never raw (§6.3).
    expect(joined.includes(ADDRESS_A)).toBe(false);
    expect(joined).toContain("op=credential-store");
    expect(joined).toContain("op=credential-rotate");
    expect(joined).toContain("op=credential-revoke");
  });

  test("[delta-03] there is no list-all-credentials API, and no route module retrieves a credential", () => {
    const storeSource = readFileSync(
      resolve(import.meta.dir, "../services/credential-store.ts"),
      "utf8",
    );
    // Tenant-scoped by construction: nothing enumerates the store.
    expect(/\blistAll\b|\blistCredentials\b|\ballCredentials\b/.test(storeSource)).toBe(false);
    const surface = Object.getOwnPropertyNames(CredentialStore.prototype);
    expect(surface.filter((name) => /^list|^all|^scan/.test(name))).toEqual([]);

    const routesDir = resolve(import.meta.dir, "../routes");
    for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts"))) {
      const contents = readFileSync(resolve(routesDir, file), "utf8");
      expect({ file, retrieves: contents.includes("getCredential(") }).toEqual({
        file,
        retrieves: false,
      });
    }
  });

  test("[delta-03] custody stays out-of-band: the credential modules mint no delegation (AP 3)", () => {
    for (const relative of [
      "../services/credential-store.ts",
      "../services/fireflies-oauth.ts",
      "../routes/connector-credentials.ts",
    ]) {
      const contents = readFileSync(resolve(import.meta.dir, relative), "utf8");
      for (const forbidden of ["createDelegation", "attenuate", "delegationStore", "issueDelegation"]) {
        expect({ relative, forbidden, present: contents.includes(forbidden) }).toEqual({
          relative,
          forbidden,
          present: false,
        });
      }
    }
  });
});

// ── The obtain flow (§6.2, branch b1 — OAuth) ────────────────────────

describe("connector credential routes", () => {
  test("[delta-03] the OAuth connect flow puts the credential straight into the backend store and never returns it", async () => {
    const harness = routeHarness();

    await withServer(harness.app, async (base) => {
      const started = await call(base, `/api/connectors/credentials/${SOURCE}/oauth/start`, "POST");
      expect(started.status).toBe(200);
      expect(started.body.authorizeUrl).toContain("code_challenge_method=S256");
      expect(typeof started.body.state).toBe("string");
      // The PKCE verifier is the backend's half of the exchange — it never rides the response.
      expect(started.text).not.toContain("verifier");

      const done = await call(
        base,
        `/api/connectors/credentials/${SOURCE}/oauth/callback`,
        "POST",
        { code: "auth-code-1", state: started.body.state },
      );
      expect(done.status).toBe(200);
      expect(done.body.connected).toBe(true);
      expect(done.text.includes(SECRET_A)).toBe(false);
      expect(done.text.includes(REFRESH_A)).toBe(false);

      const status = await call(base, `/api/connectors/credentials/${SOURCE}`, "GET");
      expect(status.status).toBe(200);
      expect(status.body.connected).toBe(true);
      expect(status.body.kind).toBe("oauth");
      expect(status.text.includes(SECRET_A)).toBe(false);
      expect(status.text.includes("ciphertext")).toBe(false);
    });

    // It landed in the BACKEND store — not in any browser vault, and as ciphertext only.
    expect(
      await harness.credentials.getCredential(SOURCE, ADDRESS_A, "fetch-worker"),
    ).toEqual(oauthSecret(SECRET_A, REFRESH_A));
    expect(harness.rows.dump().includes(SECRET_A)).toBe(false);
  });

  test("[delta-03] a callback state minted for another address is refused", async () => {
    const first = routeHarness({ address: ADDRESS_A });
    let state = "";
    await withServer(first.app, async (base) => {
      const started = await call(base, `/api/connectors/credentials/${SOURCE}/oauth/start`, "POST");
      state = started.body.state;
    });

    // Same process, a DIFFERENT session address replaying A's state.
    const second = routeHarness({ address: ADDRESS_B });
    second.cohort.add(ADDRESS_B);
    await withServer(second.app, async (base) => {
      const done = await call(
        base,
        `/api/connectors/credentials/${SOURCE}/oauth/callback`,
        "POST",
        { code: "auth-code-2", state },
      );
      expect(done.status).toBe(400);
      expect(done.body.error).toBe("invalid_state");
    });
    expect(await second.credentials.getCredential(SOURCE, ADDRESS_B, "fetch-worker")).toBeNull();
  });

  test("[delta-03] a non-cohort address gets no credential surface at all", async () => {
    const harness = routeHarness({ address: ADDRESS_B });

    await withServer(harness.app, async (base) => {
      for (const [path, method] of [
        [`/api/connectors/credentials/${SOURCE}/oauth/start`, "POST"],
        [`/api/connectors/credentials/${SOURCE}`, "GET"],
        [`/api/connectors/credentials/${SOURCE}`, "DELETE"],
      ] as const) {
        const response = await call(base, path, method);
        expect({ path, method, status: response.status }).toEqual({
          path,
          method,
          status: 404,
        });
      }
    });
  });

  test("[delta-03] disconnect revokes upstream and deletes; an upstream failure answers explicitly", async () => {
    const harness = routeHarness();
    await harness.credentials.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A),
    });

    harness.oauth.revokeFails = true;
    await withServer(harness.app, async (base) => {
      const failed = await call(base, `/api/connectors/credentials/${SOURCE}`, "DELETE");
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("upstream_revoke_failed");
      expect(failed.body.deleted).toBe(true);
      expect(failed.text.includes(SECRET_A)).toBe(false);
    });
    expect(await harness.rows.read(SOURCE, ADDRESS_A)).toBeNull();

    // The clean path.
    await harness.credentials.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: oauthSecret(SECRET_A),
    });
    harness.oauth.revokeFails = false;
    await withServer(harness.app, async (base) => {
      const ok = await call(base, `/api/connectors/credentials/${SOURCE}`, "DELETE");
      expect(ok.status).toBe(200);
      expect(ok.body.deleted).toBe(true);
      expect(ok.body.upstreamRevoked).toBe(true);
    });
    expect(harness.oauth.calls.filter((c) => c === "revoke")).toHaveLength(2);
  });
});

// ── Wiring: the surface exists only where it is supposed to ──────────

describe("index wiring", () => {
  test("[delta-03] the credential mount is flag-gated and session-authenticated", () => {
    const index = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    const mount = index.indexOf('"/api/connectors/credentials"');
    expect(mount).toBeGreaterThan(0);

    // Dark by default: the mount lives inside a `backendIngestEnabled()` guard...
    const guard = index.lastIndexOf("if (backendIngestEnabled())", mount);
    expect(guard).toBeGreaterThan(0);
    // ...and the very next thing after the path is the session auth middleware.
    expect(index.slice(mount, mount + 200)).toContain("authMiddleware");
    // The custody master is validated at boot, not at first use.
    expect(index).toContain("validateCredentialCustodyConfig(process.env)");
  });

  test("[delta-03] the fetch worker reads credentials through the REFRESHING lookup, not the bare store", () => {
    const index = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    // §6.2 "rotate": under branch b1 the access token expires as a matter of routine, so the
    // worker must rotate before use. Handing it `credentials: credentialStore` stalls a cohort
    // user's ingest permanently at the first expiry.
    const worker = index.slice(
      index.indexOf("new ConnectorFetchWorker({"),
      index.indexOf("retention: contentStore"),
    );
    expect(worker).toMatch(
      /credentials: createRefreshingCredentialLookup\(\{[\s\S]{0,200}store: credentialStore/,
    );
    // The bare store is still the ROUTER's collaborator (obtain/status/teardown) — but never the
    // worker's, which is the one path that must not present an expired token.
    expect(worker).not.toMatch(/credentials: credentialStore,/);
  });
});

// ── Rotation: OAuth refresh is automatic (§6.2 "rotate") ─────────────

describe("automatic refresh-token rotation", () => {
  test("[delta-03] an expiring OAuth credential is refreshed and re-stored before use; a fresh one is left alone", async () => {
    let clock = Date.parse("2026-08-10T12:00:00.000Z");
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, { now: () => clock });
    const refreshes: CredentialSecret[] = [];
    const client = {
      refresh: async (secret: CredentialSecret) => {
        refreshes.push(secret);
        return {
          kind: "oauth" as const,
          accessToken: "ff-access-token-AAAA-refreshed",
          refreshToken: REFRESH_A,
          expiresAt: new Date(clock + 3_600_000).toISOString(),
        };
      },
    };

    // Fresh: nothing is called, nothing is written.
    await store.store({
      source: SOURCE,
      address: ADDRESS_A,
      secret: {
        kind: "oauth",
        accessToken: SECRET_A,
        refreshToken: REFRESH_A,
        expiresAt: new Date(clock + 3_600_000).toISOString(),
      },
    });
    const untouched = await refreshOAuthCredentialIfExpiring({
      store,
      client,
      source: SOURCE,
      address: ADDRESS_A,
      now: () => clock,
    });
    expect(refreshes).toHaveLength(0);
    expect((untouched as any).accessToken).toBe(SECRET_A);

    // Inside the skew window: refreshed, re-stored, and the OLD token is gone from the substrate.
    clock += 3_500_000;
    const rotated = await refreshOAuthCredentialIfExpiring({
      store,
      client,
      source: SOURCE,
      address: ADDRESS_A,
      now: () => clock,
    });
    expect(refreshes).toHaveLength(1);
    expect((rotated as any).accessToken).toBe("ff-access-token-AAAA-refreshed");
    expect(await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker")).toEqual(
      (rotated as CredentialSecret),
    );
    expect(rows.dump().includes(SECRET_A)).toBe(false);

    // Not connected is null, never a throw and never someone else's.
    expect(
      await refreshOAuthCredentialIfExpiring({
        store,
        client,
        source: SOURCE,
        address: ADDRESS_B,
        now: () => clock,
      }),
    ).toBeNull();
  });
});

// ── PKCE (branch b1 pre-req) ─────────────────────────────────────────

describe("PKCE", () => {
  test("[delta-03] the connect flow is auth-code + PKCE S256 with a fresh verifier per attempt", () => {
    const first = createPkcePair();
    const second = createPkcePair();

    expect(first.method).toBe("S256");
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(first.verifier);
    // RFC 7636: 43-128 chars, unreserved alphabet.
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
