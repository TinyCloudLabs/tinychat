import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { once } from "events";
import type { Server } from "http";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { DEFAULT_MANIFEST_SPACE } from "@tinycloud/node-sdk/core";
import { APP_ID, type DelegationResponse, type ServerInfoPermission } from "@tinyboilerplate/core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { backendDelegationResolvedPermissions } from "../manifest.js";
import { verifyTranscriptWriterGrant } from "../delegation-verify.js";
import { activateVerifiedDelegation } from "../portable-delegation.js";
import { createDelegationRouter } from "../routes/delegations.js";
import { transcriptDeliveryConfigFromEnv } from "../services/transcription-api.js";
import { GOOGLE_AUTOJOIN_SCOPES, GOOGLE_MEET_SCOPES } from "../services/google-oauth.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant } from "./helpers/transcript-grant.js";
import {
  beginTranscriptConsentStatus,
  resolveTranscriptConsentStatus,
  transcriptConsentState,
  type TranscriptConsentState,
} from "../../../frontend/src/lib/transcriptDeliveryState";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Owned by V3; TC-641 reads this verdict but never rewrites it.
const V3_VERDICT_PATH = resolve(__dirname, "../../../test/connectors/fixtures/V3_VERDICT.json");
const BACKEND_DID = "did:key:z6MkConsentScopeProbe";

/** Observe the actual node activation DTO from a cryptographically verified session grant. */
async function activatedScope(): Promise<ServerInfoPermission[]> {
  const grant = await makeSignedTranscriptGrant();
  const result = await verifyTranscriptWriterGrant({
    serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature,
    address: grant.address, backendDid: grant.backendDid, configuredHost: grant.configuredHost,
  }, { computeDelegationCid: grant.computeDelegationCid });
  if (!result.ok) throw new Error(`Signed fixture failed verification: ${result.code}`);
  const activated: ServerInfoPermission[] = [];
  const node = {
    useDelegation: async (delegation: {
      spaceId: string;
      path: string;
      actions: string[];
      resources: Array<{ service: string; space: string }>;
    }) => {
      expect(delegation.spaceId).toBe(grant.spaceId);
      const resource = delegation.resources[0]!;
      expect(resource.space).toBe(grant.spaceId);
      activated.push({
        service: resource.service.startsWith("tinycloud.") ? resource.service : `tinycloud.${resource.service}`,
        space: DEFAULT_MANIFEST_SPACE,
        path: delegation.path,
        actions: [...delegation.actions],
      });
      return { kv: {}, sql: {} };
    },
  };
  await activateVerifiedDelegation(node as unknown as TinyCloudNode, result.verified, { host: grant.configuredHost });
  return activated;
}

interface V3Verdict {
  probedAt: string;
  nodeVersion: string;
  escapeReproduces: boolean;
  cases: {
    authorizes: boolean;
    resolvedDb: string;
    dropTable: boolean;
    exportUnderReadGrant: boolean;
    duckdb: boolean;
    kvNegativeControl: string;
  };
  verdictBy: string;
  notes?: string;
}

/** A missing or malformed scope-escape verdict cannot license a confinement claim. */
function readV3Verdict(): V3Verdict {
  if (!existsSync(V3_VERDICT_PATH)) {
    throw new Error(
      `V3's verdict artifact is missing at ${V3_VERDICT_PATH}. It is checked in and owned by ` +
        `build task V3; without it there is no evidence about the SQL delegation scope escape, ` +
        `so no confinement claim in the consent copy can be licensed. Re-run V3.`,
    );
  }
  const verdict = JSON.parse(readFileSync(V3_VERDICT_PATH, "utf-8")) as V3Verdict;
  if (typeof verdict.escapeReproduces !== "boolean" || verdict.cases === undefined) {
    throw new Error("V3's verdict artifact is malformed: expected { escapeReproduces, cases, … }");
  }
  return verdict;
}

describe("V3 verdict artifact (read-only here; owned by build task V3)", () => {
  it("is checked in and carries the recorded cases", () => {
    const verdict = readV3Verdict();

    expect(typeof verdict.probedAt).toBe("string");
    expect(typeof verdict.nodeVersion).toBe("string");
    expect(typeof verdict.verdictBy).toBe("string");
    expect(typeof verdict.escapeReproduces).toBe("boolean");
    expect(Object.keys(verdict.cases).sort()).toEqual([
      "authorizes",
      "dropTable",
      "duckdb",
      "exportUnderReadGrant",
      "kvNegativeControl",
      "resolvedDb",
    ]);
  });

  // The artifact ships `escapeReproduces: true` and stays true until a real re-run flips it.
  // A flip is only a lie this layer can catch when the recorded cases contradict it, so catch
  // that much: "fixed" means every escape case came back refused.
  it("cannot claim the escape is fixed while its own cases record it reproducing", () => {
    const { escapeReproduces, cases } = readV3Verdict();
    if (escapeReproduces) {
      expect(cases.authorizes || cases.dropTable).toBe(true);
      return;
    }

    expect(cases.authorizes).toBe(false);
    expect(cases.dropTable).toBe(false);
    expect(cases.exportUnderReadGrant).toBe(false);
    expect(cases.duckdb).toBe(false);
  });

  // If the KV negative control ever stops being refused, KV is not sound either — a new finding,
  // not a variant of this one, and the `connectors/` KV scope stops being a real boundary.
  it("records the KV negative control as refused", () => {
    expect(readV3Verdict().cases.kvNegativeControl).toBe("refused");
  });
});

describe("verified transcript-writer activation scope", () => {
  it("activates exactly the two connector resources with no schema/admin or extra KV ability", async () => {
    const activated = await activatedScope();
    expect(sortScope(activated)).toEqual(sortScope([
      { service: "tinycloud.sql", space: DEFAULT_MANIFEST_SPACE, path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
      { service: "tinycloud.kv", space: DEFAULT_MANIFEST_SPACE, path: `${APP_ID}/connectors/tinycloud-transcriber/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    ]));
    expect(sortScope(activated)).toEqual(sortScope(backendDelegationResolvedPermissions(BACKEND_DID)));
    expect(activated.some((entry) => entry.service === "tinycloud.secrets")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The ability → authorized-SQLite-AuthAction table (§3.2b), restored from origin/main.
//
// Mined from `repositories/tinycloud-node/tinycloud-core/src/sql/authorizer.rs`:
//   Insert | Delete | Update   → `write` (so `write` deletes)
//   the DDL arm, DropTable too → `admin | write | schema`
//   Read | Select | …          → any SQL ability
// The transcript-writer grant asks for `tinycloud.sql/write` on `connectors`, so it authorizes
// Delete and DROP TABLE, and "cannot delete" is never sayable while it can be active.
// ---------------------------------------------------------------------------------------------

type AuthAction =
  | "Select" | "Read" | "Transaction" | "Savepoint"
  | "Insert" | "Update" | "Delete"
  | "CreateTable" | "AlterTable" | "CreateIndex" | "DropIndex" | "CreateTrigger" | "DropTrigger"
  | "CreateView" | "DropView" | "DropTable" | "Reindex";

const READ_ACTIONS: readonly AuthAction[] = ["Select", "Read", "Transaction", "Savepoint"];
const DATA_WRITE_ACTIONS: readonly AuthAction[] = ["Insert", "Update", "Delete"];
const DDL_ACTIONS: readonly AuthAction[] = [
  "CreateTable", "DropTable", "AlterTable", "CreateIndex", "DropIndex",
  "CreateTrigger", "DropTrigger", "CreateView", "DropView", "Reindex",
];

const SQL_ABILITY_AUTH_ACTIONS: Record<string, readonly AuthAction[]> = {
  "tinycloud.sql/read": READ_ACTIONS,
  "tinycloud.sql/write": [...READ_ACTIONS, ...DATA_WRITE_ACTIONS, ...DDL_ACTIONS],
  "tinycloud.sql/schema": DDL_ACTIONS,
  "tinycloud.sql/admin": [...READ_ACTIONS, ...DATA_WRITE_ACTIONS, ...DDL_ACTIONS],
  "tinycloud.sql/*": [...READ_ACTIONS, ...DATA_WRITE_ACTIONS, ...DDL_ACTIONS],
};


/** Ability selection at the node is highest-privilege-first: `[read,write]` IS `write`. */
const SQL_ABILITY_PRECEDENCE = [
  "tinycloud.sql/*", "tinycloud.sql/admin", "tinycloud.sql/write", "tinycloud.sql/schema", "tinycloud.sql/read",
];

function selectedSqlAbility(actions: readonly string[]): string | undefined {
  return SQL_ABILITY_PRECEDENCE.find((ability) => actions.includes(ability));
}

function authorizedAuthActions(scope: readonly ServerInfoPermission[]): Set<AuthAction> {
  const authorized = new Set<AuthAction>();
  for (const entry of scope) {
    if (entry.service !== "tinycloud.sql") continue;
    const ability = selectedSqlAbility(entry.actions);
    if (ability === undefined) continue;
    for (const action of SQL_ABILITY_AUTH_ACTIONS[ability] ?? []) authorized.add(action);
  }
  return authorized;
}


describe("ability semantics — what the transcript-writer SQL ability authorizes (§3.2b)", () => {
  it("pins `write` to the delete and DDL arms, and `[read,write]` selects `write`", () => {
    const write = SQL_ABILITY_AUTH_ACTIONS["tinycloud.sql/write"]!;
    expect(write).toContain("Delete");
    expect(write).toContain("DropTable");
    expect(SQL_ABILITY_AUTH_ACTIONS["tinycloud.sql/read"]).toEqual(READ_ACTIONS);
    expect(selectedSqlAbility(["tinycloud.sql/read", "tinycloud.sql/write"])).toBe("tinycloud.sql/write");
  });

  it("is not a string check: the `del`-free activated scope still authorizes Delete and DROP TABLE", async () => {
    const activated = await activatedScope();
    expect(activated.flatMap((entry) => entry.actions).some((action) => action.endsWith("/del"))).toBe(false);
    const authorized = authorizedAuthActions(activated);
    expect(authorized.has("Delete")).toBe(true);
    expect(authorized.has("DropTable")).toBe(true);
  });
});


// The production router accepts and reports transcript-writer grants under its feature gate.

const INDEX_SOURCE = resolve(__dirname, "../index.ts");

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closing = once(server, "close");
    server.close();
    await closing;
  }
}

/** The production router, gated exactly as `index.ts` gates it on `transcriptDeliveryConfig`. */
function delegationAppFor(grant: SignedTranscriptGrant, env: NodeJS.ProcessEnv) {
  const config = transcriptDeliveryConfigFromEnv(env);
  const calls = { cid: 0, activated: [] as ServerInfoPermission[], stored: 0 };
  const records = new Map<string, { serialized: string; expiresAt: string; policyHash?: string; delegateDid?: string }>();
  const node = {
    computeDelegationCid: (authorization: string) => { calls.cid++; return grant.computeDelegationCid(authorization); },
    useDelegation: async (delegation: { path: string; actions: string[]; resources: Array<{ service: string }> }) => {
      const service = delegation.resources[0]!.service;
      calls.activated.push({
        service: service.startsWith("tinycloud.") ? service : `tinycloud.${service}`,
        space: DEFAULT_MANIFEST_SPACE,
        path: delegation.path,
        actions: [...delegation.actions],
      });
      return { kv: {}, sql: {} };
    },
  } as unknown as TinyCloudNode;
  const app = express();
  app.use("/api/delegations", createDelegationRouter({
    backendDid: grant.backendDid,
    configuredHost: grant.configuredHost,
    eligibility: (address) => config.enabled && (!config.allowlist || config.allowlist.has(address.toLowerCase())),
    node,
    store: {
      store: async (address: string, serialized: string, metadata: { expiresAt: string; policyHash?: string; delegateDid?: string }) => {
        calls.stored++;
        records.set(address.toLowerCase(), { serialized, ...metadata });
      },
      load: async (address: string) => (records.get(address.toLowerCase()) ?? null) as never,
      remove: async (address: string) => { records.delete(address.toLowerCase()); },
    },
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      req.user = { address: grant.address };
      next();
    },
  }));
  return { app, calls, config };
}

async function acceptAndReport(grant: SignedTranscriptGrant, env: NodeJS.ProcessEnv) {
  const fixture = delegationAppFor(grant, env);
  return withServer(fixture.app, async (base) => {
    const accept = await fetch(`${base}/api/delegations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature }),
    });
    const status = await (await fetch(`${base}/api/delegations/status`)).json() as DelegationResponse;
    return { fixture, accept: { status: accept.status, body: await accept.json() as Record<string, unknown> }, status };
  });
}

/** The state the frontend derives from that status, which is what selects the copy. */
function consentStateFor(address: string, status: DelegationResponse): TranscriptConsentState {
  beginTranscriptConsentStatus(address);
  resolveTranscriptConsentStatus(address, status);
  return transcriptConsentState();
}

const DELIVERY_ON = {
  TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true",
  TRANSCRIPTION_API_URL: "https://ptx.invalid",
  TRANSCRIPTION_API_KEY: "consent-scope-test-key",
};

describe("transcript delivery gate", () => {
  it("wires delegation acceptance to the default-off delivery flag", () => {
    expect(transcriptDeliveryConfigFromEnv({}).enabled).toBe(false);
    expect(transcriptDeliveryConfigFromEnv({ TRANSCRIPT_SERVER_DELIVERY_ENABLED: "false" }).enabled).toBe(false);
    const index = readFileSync(INDEX_SOURCE, "utf-8");
    expect(index).toContain(
      "const transcriptEligibility = (address: string) =>\n" +
        "    transcriptDeliveryConfig.enabled &&\n" +
        "    (!transcriptDeliveryConfig.allowlist || transcriptDeliveryConfig.allowlist.has(address.toLowerCase()));",
    );
    expect(index).toMatch(/createDelegationRouter\(\{[^}]*\beligibility: transcriptEligibility,/);
    expect(index.match(/createDelegationRouter\(/g)).toHaveLength(1);
  });

  it("refuses a valid grant when delivery is disabled", async () => {
    const grant = await makeSignedTranscriptGrant();
    for (const env of [{}, { ...DELIVERY_ON, TRANSCRIPT_SERVER_DELIVERY_ADDRESSES: `0x${"1".repeat(40)}` }]) {
      const { fixture, accept, status } = await acceptAndReport(grant, env);
      expect(accept).toEqual({ status: 403, body: { error: "delivery_disabled" } });
      expect(fixture.calls).toEqual({ cid: 0, activated: [], stored: 0 });
      expect(status).toEqual({ status: "none", expiresAt: null, verified: false, delivery: "disabled" });
      expect(consentStateFor(grant.address, status)).toBe("inactive");
    }
  });

  it("activates the verified grant and reports active or unknown delivery state", async () => {
    const grant = await makeSignedTranscriptGrant();
    const { fixture, accept, status } = await acceptAndReport(grant, DELIVERY_ON);
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: "active", verified: true, delivery: "enabled" });
    expect(fixture.calls.stored).toBe(1);
    expect(sortScope(fixture.calls.activated)).toEqual(sortScope(backendDelegationResolvedPermissions(BACKEND_DID)));
    expect(fixture.calls.activated.some((entry) => entry.service === "tinycloud.sql" && entry.actions.includes("tinycloud.sql/write"))).toBe(true);
    expect(status).toMatchObject({ status: "active", verified: true, delivery: "enabled" });
    expect(consentStateFor(grant.address, status)).toBe("active");
    expect(consentStateFor(grant.address, { ...status, delivery: "schema_missing" })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------------------------
// Restored from origin/main (deleted in 8f57f34): the per-connector truth checks. Each runs over
// every text a renderer can select for that connector — the original (delivery inactive) and the
// transcript-writer disclosure (delivery active or unknown) — so a disclosure cannot quietly drop
// a sentence the original was pinned to carry. Destructuring shadows the old names, so the bodies
// are origin/main's.
// ---------------------------------------------------------------------------------------------

/** Bulk export follows the SQL grant itself, not the ability on it (`sql/database.rs`). */
const SQL_EXPORT_IS_ABILITY_GATED = false;

function exportIsReachable(scope: readonly ServerInfoPermission[]): boolean {
  return scope.some(
    (entry) =>
      entry.service === "tinycloud.sql" &&
      (SQL_EXPORT_IS_ABILITY_GATED ? selectedSqlAbility(entry.actions) !== undefined : true),
  );
}


const DELEGATION_GATE_DOC = resolve(__dirname, "../../../docs/connector-webhooks-delegation-gate.md");
const DEPLOYMENT_DOC = resolve(__dirname, "../../../docs/deployment.md");
function readDoc(path: string): string {
  if (!existsSync(path)) throw new Error(`Missing record: ${path}`);
  return readFileSync(path, "utf-8");
}


describe("bulk export (§3.2b)", () => {
  it("treats bulk export as reachable under any SQL ability, read included", async () => {
    expect(SQL_EXPORT_IS_ABILITY_GATED).toBe(false);
    expect(exportIsReachable([
      { service: "tinycloud.sql", path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read"] },
    ])).toBe(true);
    // Re-pointed: the transcript-writer grant is the SQL grant that now exists.
    expect(exportIsReachable(await activatedScope())).toBe(true);
    expect(exportIsReachable([
      { service: "tinycloud.kv", path: `${APP_ID}/connectors/`, actions: ["tinycloud.kv/get"] },
    ])).toBe(false);
  });
});

describe("Google OAuth scope contracts", () => {
  it("limits Calendar autojoin to owned events and identity scopes", () => {
    expect(GOOGLE_AUTOJOIN_SCOPES.split(" ").sort()).toEqual([
      "email", "https://www.googleapis.com/auth/calendar.events.owned.readonly", "openid",
    ]);
  });

  it("requests only the Meet, Drive metadata and Docs scopes", () => {
    expect(GOOGLE_MEET_SCOPES.split(" ")).toEqual([
      "https://www.googleapis.com/auth/meetings.space.readonly",
      "https://www.googleapis.com/auth/meetings.space.settings",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ]);
    expect(GOOGLE_MEET_SCOPES).not.toMatch(/calendar|gmail/i);
  });
});

describe("the Option-C truth pass — the records describe the selected product", () => {
  it("records Option C as SELECTED, on V4's grounds, not as a blocked prototype", () => {
    const doc = readDoc(DELEGATION_GATE_DOC);
    // Re-pointed: TC-641 rewrote the lead status line (it was "**Status: … Option C is SELECTED"),
    // so read the doc's first bold line, whatever it is called.
    const status = doc.split("\n").find((line) => line.startsWith("**")) ?? "";
    expect(status).toMatch(/Option C is selected/i);
    expect(status).not.toContain("BLOCKED on operator action");
    expect(doc).toContain("V4");
    expect(doc).toContain("unsigned");
    expect(doc).toContain("`att`");
    expect(doc).not.toContain("inverts its pre-widening assertions automatically");
    expect(doc).toContain("backendDelegationPermissions()");
  });

  it("records the TC-641 transcript writer as separate, and its scope-escape gate as still open", () => {
    const doc = readDoc(DELEGATION_GATE_DOC);
    expect(doc.indexOf("## 4. TC-641")).toBeGreaterThan(-1);
    const tc641 = doc.slice(doc.indexOf("## 4. TC-641"));
    // The same verdict this file reads, named as the open gate, with no risk acceptance.
    expect(readV3Verdict().escapeReproduces).toBe(true);
    expect(tc641).toMatch(/scope-escape gate is still open/i);
    expect(tc641).toContain("TC-825");
    expect(tc641).toMatch(/no production risk acceptance/i);
    expect(tc641).toContain("`TRANSCRIPT_SERVER_DELIVERY_ENABLED=false` in production");
    expect(tc641).not.toMatch(/\bconfined to\b|\bcannot reach\b/i);
  });

  it("names the provider-dashboard registration check as an OPERATOR pre-rollout gate", () => {
    const doc = readDoc(DEPLOYMENT_DOC);
    expect(doc).toContain("32-character");
    expect(doc).toContain("43-character");
    expect(doc).toMatch(/operator pre-rollout gate/i);
    expect(doc).toMatch(/has not been (?:performed|run)/i);
    expect(doc).not.toMatch(/(?:verified|confirmed) (?:in|against) the (?:real )?fireflies dashboard/i);
    expect(doc).toMatch(/flipping the flag is an operator action/i);
  });

  it("describes BOTH server roles in the deploy doc, each scoped to who gets it", () => {
    const doc = readDoc(DEPLOYMENT_DOC);
    expect(doc).toContain("Option C");
    expect(doc).toContain("/api/connectors/webhooks/ack");
    expect(doc).toMatch(/(?:outside the cohort|non-cohort)[\s\S]{0,400}never receives .{0,40}Fireflies (?:API )?key/i);
    expect(doc).toMatch(/holds a per-user Fireflies OAuth credential/i);
    expect(doc).toMatch(/full-account/i);
    expect(doc).toMatch(/keeps its own copy/i);
    expect(doc).toMatch(/encrypted under\s+`CONNECTOR_CONTENT_MASTER`/);
    expect(doc).toMatch(
      /Disconnect\/purge deletes reconciled stored meetings and the credential immediately/i,
    );
    expect(doc).toMatch(/no connector delegation/i);
  });
});

function sortScope(scope: readonly ServerInfoPermission[]): ServerInfoPermission[] {
  return scope
    .map((entry) => ({
      service: entry.service,
      space: entry.space ?? DEFAULT_MANIFEST_SPACE,
      path: entry.path,
      actions: [...entry.actions].sort(),
    }))
    .sort((a, b) => `${a.service}|${a.path}`.localeCompare(`${b.service}|${b.path}`));
}
