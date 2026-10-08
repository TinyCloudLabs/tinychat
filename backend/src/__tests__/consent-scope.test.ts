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
import { RETENTION_WINDOW_DAYS } from "../services/content-store.js";
import { GOOGLE_MEET_SCOPES } from "../services/google-oauth.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant } from "./helpers/transcript-grant.js";
import * as consentCopyModule from "../../../frontend/src/lib/connectors/consentCopy";
import {
  BACKEND_INGEST_CONSENT_COPY,
  BACKGROUND_SYNC_CONSENT_COPY,
  GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY,
  GOOGLE_MEET_CONSENT_COPY,
  GOOGLE_TESTING_MODE_REAUTH_COPY,
  consentCopyText,
  googleConsentCopyForSystemBrowser,
  transcriptAwareConsentCopy,
  type BackgroundSyncConsentCopy,
} from "../../../frontend/src/lib/connectors/consentCopy";
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

/** Removing data the user did not ask us to remove. What "cannot delete" would have to deny. */
const DESTRUCTIVE_ACTIONS: readonly AuthAction[] = [
  "Delete", "Update", "DropTable", "AlterTable", "DropIndex", "DropTrigger", "DropView",
];

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

// ---------------------------------------------------------------------------------------------
// Claim patterns, restored from origin/main unchanged.
// ---------------------------------------------------------------------------------------------

/**
 * Sentences that assert the grant CANNOT REACH something. Forbidden in every copy variant while
 * V3's verdict records the scope escape as reproducing (§0a). Saying what we *ask for* is still
 * permitted — that is the distinction these patterns are drawn along.
 */
const CONFINEMENT_CLAIMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\band nothing else\b/, label: "and nothing else" },
  { pattern: /\bonly your connectors data\b/, label: "only your connectors data" },
  { pattern: /\bnot your (?:chats|threads|memory|saved keys|key)\b/, label: "not your chats" },
  { pattern: /\bcan(?:not|'t) reach\b/, label: "cannot reach" },
  { pattern: /\bnever reaches\b/, label: "never reaches" },
  { pattern: /\bconfined to\b/, label: "confined to" },
  { pattern: /\bcan(?:not|'t) (?:touch|see|open|access|read) (?:your|anything|any)\b/, label: "cannot access X" },
  { pattern: /\bnothing (?:but|other than) your connectors\b/, label: "nothing but your connectors" },
  { pattern: /\b(?:limited|restricted) to your connectors\b/, label: "limited to your connectors" },
  { pattern: /\bstays? (?:inside|within) (?:your |the )?connectors\b/, label: "stays inside connectors" },
];

/** Capability claims about deletion, falsified by `sql/write` ⇒ `Delete`/`DropTable` (§3.2b). */
const DELETE_CAPABILITY_CLAIMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bcan(?:not|'t) delete\b/, label: "cannot delete" },
  { pattern: /\bcan(?:not|'t) remove\b/, label: "cannot remove" },
  { pattern: /\bonly you can delete\b/, label: "only you can delete" },
  { pattern: /\bno (?:power|ability) to delete\b/, label: "no ability to delete" },
];

/**
 * TC-641: unscoped sentences saying the server does not or cannot write into the user's space.
 * True of the inactive copy (the flag-off backend accepts no grant), false once delivery is
 * active, so none may appear in an active-or-unknown disclosure. A sentence scoped to a toggle
 * ("Turning this on gives our server no new permission") stays allowed next to the disclosure.
 */
const SERVER_WRITE_DENIALS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bnothing is granted\b/, label: "nothing is granted" },
  { pattern: /\bno standing that would let it\b/, label: "no standing to write" },
  { pattern: /\bnever (?:saves|writes|stores) (?:a |any )?(?:meeting|transcript)/, label: "never saves a meeting" },
  { pattern: /\bwrites no (?:meeting|transcript)/, label: "writes no meeting" },
  { pattern: /\byour browser does that, every time\b/, label: "browser does that every time" },
  { pattern: /\bserver (?:can(?:not|'t)|could not|will never|never|does not|doesn't) (?:write|save|store|add)\b/, label: "server cannot write" },
  { pattern: /\bonly your browser (?:writes|saves|stores)\b/, label: "only your browser writes" },
];

/** The disclosure an active-or-unknown transcript-writer grant must carry. */
const TRANSCRIPT_WRITER_DISCLOSURE = "our server can save its meeting transcripts into your space";

function normalize(text: string): string {
  return text
    .replace(/[*_`]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matched(claims: ReadonlyArray<{ pattern: RegExp; label: string }>, text: string): string[] {
  return claims.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

// ---------------------------------------------------------------------------------------------
// Every consent-copy variant a renderer can select: each connector's original, through every
// transcript-delivery state, in both Google authorize surfaces.
// ---------------------------------------------------------------------------------------------

const CONNECTOR_COPIES: readonly BackgroundSyncConsentCopy[] = [
  BACKGROUND_SYNC_CONSENT_COPY,
  BACKEND_INGEST_CONSENT_COPY,
  GOOGLE_MEET_CONSENT_COPY,
  GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY,
];
const DELIVERY_STATES: readonly TranscriptConsentState[] = ["inactive", "unknown", "active"];

interface RenderedVariant {
  connector: string;
  state: TranscriptConsentState;
  surface: "in-app" | "system-browser";
  copy: BackgroundSyncConsentCopy;
  text: string;
}

function renderedVariants(connectors: readonly BackgroundSyncConsentCopy[] = CONNECTOR_COPIES): RenderedVariant[] {
  return connectors.flatMap((base) => DELIVERY_STATES.flatMap((state) => {
    const copy = transcriptAwareConsentCopy(base, state);
    return ([
      ["in-app", copy],
      ["system-browser", googleConsentCopyForSystemBrowser(copy)],
    ] as const).map(([surface, rendered]) => ({
      connector: base.variant, state, surface, copy: rendered, text: normalize(consentCopyText(rendered)),
    }));
  }));
}

/** Every exported copy object and string, so a new variant cannot ship unscanned. */
function exportedCopies(): { objects: BackgroundSyncConsentCopy[]; strings: Array<[string, string]> } {
  const objects: BackgroundSyncConsentCopy[] = [];
  const strings: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(consentCopyModule)) {
    if (typeof value === "string") strings.push([name, value]);
    else if (typeof value === "object" && value !== null && "variant" in value) {
      objects.push(value as BackgroundSyncConsentCopy);
    }
  }
  return { objects, strings };
}

function claimsIn(variants: readonly RenderedVariant[], claims: ReadonlyArray<{ pattern: RegExp; label: string }>) {
  return variants
    .map(({ connector, state, surface, text }) => ({ connector, state, surface, found: matched(claims, text) }))
    .filter(({ found }) => found.length > 0);
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

describe("consent copy deny-lists — every connector, every transcript-delivery state", () => {
  it("scans every exported consent-copy variant and string", () => {
    const scanned = new Set(renderedVariants().map(({ copy }) => copy.variant));
    const { objects, strings } = exportedCopies();
    expect(objects.length).toBeGreaterThanOrEqual(8);
    for (const copy of objects) expect({ variant: copy.variant, scanned: scanned.has(copy.variant) }).toEqual({ variant: copy.variant, scanned: true });
    // Every active variant is reachable from its connector, not merely exported.
    expect([...scanned].sort()).toEqual(objects.map((copy) => copy.variant).sort());
    expect(strings.map(([name]) => name)).toContain("GOOGLE_TESTING_MODE_REAUTH_COPY");
  });

  it("catches each listed claim, so a pattern cannot rot into a silent pass", () => {
    expect(matched(CONFINEMENT_CLAIMS, normalize("We read your meetings **and nothing else**."))).toEqual(["and nothing else"]);
    expect(matched(CONFINEMENT_CLAIMS, normalize("It can’t reach your chats."))).toEqual(["cannot reach"]);
    expect(matched(DELETE_CAPABILITY_CLAIMS, normalize("Our server cannot delete anything."))).toEqual(["cannot delete"]);
    expect(matched(SERVER_WRITE_DENIALS, normalize("Our server can't write to your space."))).toEqual(["server cannot write"]);
  });

  it("carries no confinement claim while V3 records the escape reproducing", () => {
    const { escapeReproduces } = readV3Verdict();
    const variants = renderedVariants();
    expect(variants.length).toBe(CONNECTOR_COPIES.length * DELIVERY_STATES.length * 2);
    // Unconditional: neither dropping a grant nor adding one licenses a sentence about what a
    // permission cannot reach. Only a node fix recorded in V3's artifact would.
    expect(escapeReproduces ? claimsIn(variants, CONFINEMENT_CLAIMS) : []).toEqual([]);
    const strings = exportedCopies().strings.map(([name, text]) => ({ name, found: matched(CONFINEMENT_CLAIMS, normalize(text)) }));
    expect(escapeReproduces ? strings.filter(({ found }) => found.length > 0) : []).toEqual([]);
  });

  it("makes no delete-capability claim either", async () => {
    // Calibrated against the real transcript-writer grant: `sql/write` authorizes Delete and
    // DropTable on whatever database the node resolves, so "cannot delete" is never sayable.
    const authorized = authorizedAuthActions(await activatedScope());
    expect(DESTRUCTIVE_ACTIONS.filter((action) => authorized.has(action)).length).toBeGreaterThan(0);
    expect(claimsIn(renderedVariants(), DELETE_CAPABILITY_CLAIMS)).toEqual([]);
    const strings = exportedCopies().strings.map(([name, text]) => ({ name, found: matched(DELETE_CAPABILITY_CLAIMS, normalize(text)) }));
    expect(strings.filter(({ found }) => found.length > 0)).toEqual([]);
  });

  // The per-connector guards (origin/main's cohort and Google Meet tests), extended to every
  // connector and to the transcript-writer disclosures each one can select.
  for (const base of CONNECTOR_COPIES) {
    it(`${base.variant}: makes no confinement or delete-capability claim in any delivery state`, () => {
      const { escapeReproduces } = readV3Verdict();
      const variants = renderedVariants([base]);
      expect(new Set(variants.map(({ copy }) => copy.variant)).size).toBe(2);
      expect(escapeReproduces ? claimsIn(variants, CONFINEMENT_CLAIMS) : []).toEqual([]);
      expect(claimsIn(variants, DELETE_CAPABILITY_CLAIMS)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Copy ↔ policy: origin/main's "no new permission … and the policy agrees" tests, re-pointed at
// the transcript-writer grant. The copy a user reads follows the delegation status the backend
// reports, so each state's copy is checked against the router that produces that status.
// ---------------------------------------------------------------------------------------------

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

describe("copy ↔ transcript-writer policy", () => {
  it("wires delegation acceptance to the default-off delivery flag", () => {
    expect(transcriptDeliveryConfigFromEnv({}).enabled).toBe(false);
    expect(transcriptDeliveryConfigFromEnv({ TRANSCRIPT_SERVER_DELIVERY_ENABLED: "false" }).enabled).toBe(false);
    const index = readFileSync(INDEX_SOURCE, "utf-8");
    // The router `delegationAppFor` builds is the one index.ts builds, behind the same gate.
    expect(index).toContain(
      "const transcriptEligibility = (address: string) =>\n" +
        "    transcriptDeliveryConfig.enabled &&\n" +
        "    (!transcriptDeliveryConfig.allowlist || transcriptDeliveryConfig.allowlist.has(address.toLowerCase()));",
    );
    expect(index).toMatch(/createDelegationRouter\(\{[^}]*\beligibility: transcriptEligibility,/);
    expect(index.match(/createDelegationRouter\(/g)).toHaveLength(1);
  });

  it("delivery inactive: the original copy holds, and the policy agrees — the flag-off backend accepts no grant", async () => {
    const grant = await makeSignedTranscriptGrant();
    for (const env of [{}, { ...DELIVERY_ON, TRANSCRIPT_SERVER_DELIVERY_ADDRESSES: `0x${"1".repeat(40)}` }]) {
      const { fixture, accept, status } = await acceptAndReport(grant, env);
      // A valid signed grant is refused before it is read, verified, activated or stored.
      expect(accept).toEqual({ status: 403, body: { error: "delivery_disabled" } });
      expect(fixture.calls).toEqual({ cid: 0, activated: [], stored: 0 });
      expect(status).toEqual({ status: "none", expiresAt: null, verified: false, delivery: "disabled" });
      expect(consentStateFor(grant.address, status)).toBe("inactive");
    }

    for (const base of CONNECTOR_COPIES) {
      // Byte-identical: the inactive copy IS the original, not a re-render of it.
      expect(transcriptAwareConsentCopy(base, "inactive")).toBe(base);
      const text = normalize(consentCopyText(base));
      expect(text).toContain("no new permission");
      expect(text).not.toContain(TRANSCRIPT_WRITER_DISCLOSURE);
    }
    // The originals' write denials are exactly the sentences an active grant would falsify.
    for (const base of [BACKGROUND_SYNC_CONSENT_COPY, BACKEND_INGEST_CONSENT_COPY, GOOGLE_MEET_CONSENT_COPY]) {
      expect(matched(SERVER_WRITE_DENIALS, normalize(consentCopyText(base)))).toContain("nothing is granted");
    }
  });

  it("delivery active: the copy discloses that the server can write transcripts, and claims nothing to the contrary", async () => {
    const grant = await makeSignedTranscriptGrant();
    const { fixture, accept, status } = await acceptAndReport(grant, DELIVERY_ON);
    // The policy the disclosure describes: the signed grant is accepted and activates exactly the
    // transcript-writer scope — connectors SQL read/write and the transcriber KV prefix.
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: "active", verified: true, delivery: "enabled" });
    expect(fixture.calls.stored).toBe(1);
    expect(sortScope(fixture.calls.activated)).toEqual(sortScope(backendDelegationResolvedPermissions(BACKEND_DID)));
    expect(fixture.calls.activated.some((entry) => entry.service === "tinycloud.sql" && entry.actions.includes("tinycloud.sql/write"))).toBe(true);
    expect(status).toMatchObject({ status: "active", verified: true, delivery: "enabled" });
    expect(consentStateFor(grant.address, status)).toBe("active");
    // An active grant whose schema is not yet ready is "unknown", which discloses too.
    expect(consentStateFor(grant.address, { ...status, delivery: "schema_missing" })).toBe("unknown");

    for (const state of ["active", "unknown"] as const) {
      for (const base of CONNECTOR_COPIES) {
        const copy = transcriptAwareConsentCopy(base, state);
        expect(copy).not.toBe(base);
        expect(copy.variant).toBe(`${base.variant}-transcript-writer` as typeof copy.variant);
        for (const rendered of [copy, googleConsentCopyForSystemBrowser(copy)]) {
          const text = normalize(consentCopyText(rendered));
          expect({ variant: rendered.variant, state, discloses: text.includes(TRANSCRIPT_WRITER_DISCLOSURE) })
            .toEqual({ variant: rendered.variant, state, discloses: true });
          expect({ variant: rendered.variant, state, denials: matched(SERVER_WRITE_DENIALS, text) })
            .toEqual({ variant: rendered.variant, state, denials: [] });
        }
      }
    }
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

interface SelectableCopy { state: "inactive" | "active"; copy: BackgroundSyncConsentCopy; text: string }

/** The original and the active-or-unknown disclosure (one object serves both of those states). */
function selectable(base: BackgroundSyncConsentCopy, surfaces: "in-app" | "both" = "in-app"): SelectableCopy[] {
  const inactive = transcriptAwareConsentCopy(base, "inactive");
  const active = transcriptAwareConsentCopy(base, "active");
  expect(transcriptAwareConsentCopy(base, "unknown")).toBe(active);
  const copies: Array<[SelectableCopy["state"], BackgroundSyncConsentCopy]> = [["inactive", inactive], ["active", active]];
  if (surfaces === "both") {
    copies.push(["inactive", googleConsentCopyForSystemBrowser(inactive)], ["active", googleConsentCopyForSystemBrowser(active)]);
  }
  return copies.map(([state, copy]) => ({ state, copy, text: normalize(consentCopyText(copy)) }));
}

const DELEGATION_GATE_DOC = resolve(__dirname, "../../../docs/connector-webhooks-delegation-gate.md");
const DEPLOYMENT_DOC = resolve(__dirname, "../../../docs/deployment.md");
const RESIDUALS_DOC = resolve(__dirname, "../../../docs/connector-webhooks-p1-residuals.md");
/** The operator-facing mirror of the cohort copy; the fidelity test parses it field by field. */
const COHORT_COPY_DOC = resolve(__dirname, "../../../docs/connector-webhooks-backend-ingest-consent-copy.md");
/** The renderer of background-sync consent copy — read as SOURCE. */
const CONSENT_RENDERER = resolve(__dirname, "../../../frontend/src/chat/BackgroundSyncSection.tsx");
/** The approval doc's mirror of the one paragraph the transcript-writer variant replaces. */
const TRANSCRIPT_WRITER_BULLET = "transcript-writer bullet 4";
const TRANSCRIPT_WRITER_BULLET_INDEX = 3;

function readDoc(path: string): string {
  if (!existsSync(path)) throw new Error(`Missing record: ${path}`);
  return readFileSync(path, "utf-8");
}

/**
 * Parse the approval mirror: `## <field>` followed by a single blockquote paragraph. Whitespace is
 * collapsed on both sides; every other character, `**bold**` markers included, must match.
 */
function parseApprovedCopy(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const line of markdown.split("\n")) {
    const headed = /^## (.+?)\s*$/.exec(line);
    if (headed) {
      current = headed[1]!;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("> ")) fields[current] = `${fields[current] ?? ""} ${line.slice(2).trim()}`.trim();
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replace(/\s+/g, " ").trim()]));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

describe("Option C consent copy (§3.8), in every delivery state", () => {
  it("carries no consent checkbox — Option B's is deleted, not left dormant", () => {
    for (const { copy: COPY, text: COPY_TEXT } of selectable(BACKGROUND_SYNC_CONSENT_COPY)) {
      expect("checkbox" in COPY).toBe(false);
      expect(COPY_TEXT).not.toContain("i understand that");
      expect(COPY.consentCheckbox).toBeUndefined();
      expect(COPY.disconnectNote).toBeUndefined();
    }
  });

  it("makes no grant claim while delivery is inactive, because no grant is accepted", () => {
    // Scoped: with delivery active the transcript-writer grant exists and the disclosure says so
    // (the copy ↔ transcript-writer policy tests). Option B's grant sentences stay absent in both.
    for (const { state, text: COPY_TEXT } of selectable(BACKGROUND_SYNC_CONSENT_COPY)) {
      expect(COPY_TEXT).not.toContain("standing permission");
      expect(COPY_TEXT).not.toContain("what that permission can technically do");
      expect(COPY_TEXT).not.toContain("including your chats");
      expect(COPY_TEXT).not.toContain("expires after 7 days");
      expect(COPY_TEXT).not.toContain("we ask for it on your connectors data");
      expect(COPY_TEXT).toContain("no new permission");
      if (state === "inactive") expect(COPY_TEXT).toContain("nothing is granted");
    }
  });

  it("keeps Option C's custody sentences for the non-cohort user", () => {
    // Fireflies custody is unchanged by transcript delivery: the server still never sees the
    // Fireflies key and never receives the Fireflies meeting.
    for (const { state, copy: COPY, text: COPY_TEXT } of selectable(BACKGROUND_SYNC_CONSENT_COPY)) {
      expect(COPY.variant).toBe(state === "inactive" ? "C" : "C-transcript-writer");
      expect(COPY_TEXT).toContain("which meetings are ready");
      expect(COPY_TEXT).toContain("never sees your fireflies key");
      expect(COPY_TEXT).toContain("it never receives the meeting itself");
    }
  });

  it("says plainly that this is not fully-offline ingestion", () => {
    for (const { text: COPY_TEXT } of selectable(BACKGROUND_SYNC_CONSENT_COPY)) {
      expect(COPY_TEXT).toContain("this is not fully-offline ingestion");
      expect(COPY_TEXT).toContain("your next visit");
      expect(COPY_TEXT).not.toContain("even while tinychat is closed the meeting");
    }
  });

  it("discloses the publicly readable operational log (§6.3 / T13)", () => {
    for (const { text: COPY_TEXT } of selectable(BACKGROUND_SYNC_CONSENT_COPY)) {
      expect(COPY_TEXT).toContain("publicly readable");
      expect(COPY_TEXT).toContain("scrambled stand-ins");
    }
  });

  it("still warns that the delivery URL is a credential", () => {
    for (const { text: COPY_TEXT } of selectable(BACKGROUND_SYNC_CONSENT_COPY)) {
      expect(COPY_TEXT).toContain("like a password");
    }
  });
});

describe("the cohort consent copy tells the new truth (plan §11 requirements 1-4), in every delivery state", () => {
  it("carries no 'never sees your key' / 'never receives the meeting' formulation", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).not.toContain("never sees your fireflies key");
      expect(COHORT_TEXT).not.toContain("never receives the meeting");
      for (const stale of [
        /\bnever (?:sees|saw|receives|received|holds|stores) your (?:fireflies )?(?:api )?key\b/,
        /\bthe key stays where it is today\b/,
        /\bonly your browser reads it\b/,
        /\bnever writes? (?:a )?meeting content\b/,
      ]) {
        expect({ stale: stale.source, found: stale.test(COHORT_TEXT) }).toEqual({ stale: stale.source, found: false });
      }
    }
  });

  it("says the server holds a Fireflies credential, and what it could do if breached", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toContain("fireflies credential");
      expect(COHORT_TEXT).toContain("oauth token");
      expect(COHORT_TEXT).toMatch(/no read-only permission/);
      expect(COHORT_TEXT).toMatch(/\bdelete them\b/);
      expect(COHORT_TEXT).toMatch(/\breshare\b/);
      expect(COHORT_TEXT).toMatch(/if our server is breached/);
      expect(COHORT_TEXT).toMatch(/revoked? or expires/);
      expect(COHORT_TEXT).toContain("revoke");
    }
  });

  it("says the meeting is stored server-side, encrypted, for the D2a window, and deleted", () => {
    expect(RETENTION_WINDOW_DAYS).toBe(90);
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toContain("keeps its own copy");
      expect(COHORT_TEXT).toContain("encrypted at rest");
      expect(COHORT_TEXT).toContain(`${RETENTION_WINDOW_DAYS} days`);
      expect(COHORT_TEXT).toMatch(/disconnecting[^.]*deletes the stored meetings/);
      expect(COHORT_TEXT).toContain("purge");
    }
  });

  it("promises only the meetings the user owns", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toMatch(/the meetings you own/);
      expect(COHORT_TEXT).toMatch(/owned by someone else[^.]*is not sent to us/);
      for (const overclaim of [
        /every meeting (?:in|on|from) your (?:team|workspace|organi[sz]ation)/,
        /all (?:your )?team meetings/,
        /every meeting you (?:attend|are invited to)/,
        /everyone'?s meetings/,
      ]) {
        expect({ overclaim: overclaim.source, found: overclaim.test(COHORT_TEXT) }).toEqual({ overclaim: overclaim.source, found: false });
      }
    }
  });

  it("keeps the credential outside the user's space in both texts", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toContain("no new permission");
      expect(COHORT_TEXT).toContain("outside your space");
    }
  });

  it("keeps the disclosures that survive the mode change", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toContain("publicly readable");
      expect(COHORT_TEXT).toContain("scrambled stand-ins");
      expect(COHORT_TEXT).toContain("like a password");
    }
  });

  it("says what happens when the upstream revoke fails, rather than promising it always works", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toMatch(/if that upstream revoke fails we tell you so/);
      expect(COHORT_TEXT).toMatch(/we cannot revoke upstream, we tell you so/);
      expect(COHORT_TEXT).toMatch(/instead of pretending it worked/);
      for (const overpromise of [
        /disconnecting here revokes it too\b/,
        /\brevokes the credential with fireflies\b/,
        /\brevocation is (?:immediate|instant)/,
      ]) {
        expect({ overpromise: overpromise.source, found: overpromise.test(COHORT_TEXT) }).toEqual({ overpromise: overpromise.source, found: false });
      }
    }
  });

  it("carries the attestation checkbox, naming both disclosures", () => {
    for (const { copy: COHORT_COPY } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_COPY.consentCheckbox).toBeDefined();
      expect(COHORT_COPY.disconnectNote).toBeDefined();
      const attestation = normalize(COHORT_COPY.consentCheckbox ?? "");
      expect(attestation).toContain("full-account fireflies token");
      expect(attestation).toContain(`${RETENTION_WINDOW_DAYS} days`);
    }
  });

  it("bounds the 'already there' promise to a signed-in session", () => {
    for (const { text: COHORT_TEXT } of selectable(BACKEND_INGEST_CONSENT_COPY)) {
      expect(COHORT_TEXT).toMatch(/signing in is still required/);
      expect(COHORT_TEXT).toMatch(/not mean your meetings are reachable without signing in/);
    }
  });

  /**
   * The approval artifact and the shipped constant are ONE text. The Gate 6 approval covers the
   * original cohort copy, which is what renders while delivery is inactive, so that is matched
   * sentence for sentence. The transcript-writer variant replaces one paragraph the operator has
   * NOT approved: the doc mirrors it under an explicit "NOT APPROVED" status, never inside the
   * approved text, and this test holds the mirror to the shipped words and the rest of the
   * variant to the approved text.
   */
  it("matches the operator approval artifact sentence for sentence", () => {
    const doc = readDoc(COHORT_COPY_DOC);
    const approved = parseApprovedCopy(doc);
    const COHORT_COPY = BACKEND_INGEST_CONSENT_COPY;

    expect(approved.variant).toBe(COHORT_COPY.variant);
    expect(approved.heading).toBe(collapse(COHORT_COPY.heading));
    expect(approved.intro).toBe(collapse(COHORT_COPY.intro));
    expect(approved.changesHeading).toBe(collapse(COHORT_COPY.changesHeading));
    expect(approved.consentCheckbox).toBe(collapse(COHORT_COPY.consentCheckbox ?? ""));
    expect(approved.disconnectNote).toBe(collapse(COHORT_COPY.disconnectNote ?? ""));
    const approvedBullets = Object.keys(approved).filter((key) => key.startsWith("bullet "));
    expect(approvedBullets.length).toBe(COHORT_COPY.bullets.length);
    COHORT_COPY.bullets.forEach((bullet, index) => {
      expect(approved[`bullet ${index + 1}`]).toBe(collapse(bullet));
    });

    // The transcript-writer variant: the approved text except the one mirrored paragraph.
    const active = transcriptAwareConsentCopy(COHORT_COPY, "active");
    expect({ ...active, variant: COHORT_COPY.variant, bullets: [] }).toEqual({ ...COHORT_COPY, bullets: [] });
    expect(active.bullets.length).toBe(COHORT_COPY.bullets.length);
    active.bullets.forEach((bullet, index) => {
      if (index === TRANSCRIPT_WRITER_BULLET_INDEX) expect(collapse(bullet)).not.toBe(approved[`bullet ${index + 1}`]);
      else expect(collapse(bullet)).toBe(approved[`bullet ${index + 1}`]);
    });
    expect(approved[TRANSCRIPT_WRITER_BULLET]).toBe(collapse(active.bullets[TRANSCRIPT_WRITER_BULLET_INDEX]!));
    // …and the mirror says, in its own section, that it is not approved.
    const section = doc.slice(doc.indexOf("## Transcript-writer variant"));
    expect(section.indexOf(`## ${TRANSCRIPT_WRITER_BULLET}`)).toBeGreaterThan(0);
    expect(section.slice(0, section.indexOf(`## ${TRANSCRIPT_WRITER_BULLET}`))).toContain("**Status: NOT APPROVED.**");
    expect(doc.slice(0, doc.indexOf("## Transcript-writer variant"))).not.toContain(TRANSCRIPT_WRITER_NOTICE_TEXT);
  });

  it("records the consent surface's wiring state honestly in both directions", () => {
    const renderer = readDoc(CONSENT_RENDERER);
    const deployment = readDoc(DEPLOYMENT_DOC);
    const residuals = readDoc(RESIDUALS_DOC);
    const wired = renderer.includes("BACKEND_INGEST_CONSENT_COPY");

    if (!wired) {
      expect(renderer).toContain("BACKGROUND_SYNC_CONSENT_COPY");
      expect(deployment).toMatch(/NOT yet wired/);
      expect(deployment).toMatch(/pre-rollout gate/i);
      expect(residuals).toMatch(/F011/);
      expect(residuals).toMatch(/BACKEND_INGEST_CONSENT_COPY/);
    } else {
      expect(deployment).not.toMatch(/NOT yet wired/);
    }
  });
});

/** The transcript-writer notice as the frontend renders it (normalized). */
const TRANSCRIPT_WRITER_NOTICE_TEXT = "can save its meeting transcripts into your space";

describe("the Google Meet consent copy (connector plan §4.1/§4.3, WP-C), in every delivery state and surface", () => {
  const scopes = GOOGLE_MEET_SCOPES.split(" ");

  it("names Google and OAuth, and describes the Meet, Drive metadata, and Docs scopes requested", () => {
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/meetings.space.readonly",
      "https://www.googleapis.com/auth/meetings.space.settings",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ]);
    expect(GOOGLE_MEET_SCOPES).not.toMatch(/calendar|gmail/i);

    for (const { state, copy: GOOGLE_COPY, text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_COPY.variant).toBe(state === "inactive" ? "google-oauth" : "google-oauth-transcript-writer");
      expect(GOOGLE_TEXT).toContain("google");
      expect(GOOGLE_TEXT).toContain("oauth");
      const readable = GOOGLE_TEXT.indexOf("transcripts");
      const settings = GOOGLE_TEXT.indexOf("change google meet transcription settings");
      expect(readable).toBeGreaterThan(-1);
      expect(settings).toBeGreaterThan(-1);
      expect(readable).toBeLessThan(settings);
      expect(GOOGLE_TEXT).toMatch(/who took part/);
      expect(GOOGLE_TEXT).toMatch(/meetings you host/);
      expect(GOOGLE_TEXT).toMatch(/see drive file metadata and read matching google docs/);
      expect(GOOGLE_TEXT).toContain("no calendar or gmail permission is requested");
    }
  });

  it("discloses the transient backend token visibility instead of smoothing it", () => {
    for (const { text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_TEXT).toMatch(/client secret/);
      expect(GOOGLE_TEXT).toMatch(/token refresh/);
      expect(GOOGLE_TEXT).toMatch(/(goes|go) through our backend/);
      expect(GOOGLE_TEXT).toContain("cvm");
      expect(GOOGLE_TEXT).toContain("persists nothing");
      expect(GOOGLE_TEXT).toMatch(/no log line carrying a token/);
      expect(GOOGLE_TEXT).toMatch(/encrypted secrets/);
    }
  });

  it("says the browser fetches the meeting itself, and where the data lands", () => {
    for (const { text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_TEXT).toMatch(/browser talks to google directly/);
      expect(GOOGLE_TEXT).toMatch(/never passes through tinychat's server/);
      expect(GOOGLE_TEXT).toMatch(/written straight into your space/);
      expect(GOOGLE_TEXT).toMatch(/we keep no copy of it/);
    }
  });

  it("states the coverage cliff with its cause, and names what closes the gap", () => {
    for (const { text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_TEXT).toMatch(/paid google workspace edition/);
      expect(GOOGLE_TEXT).toMatch(/transcription was switched on for that meeting/);
      expect(GOOGLE_TEXT).toMatch(/free\/consumer google account/);
      expect(GOOGLE_TEXT).toMatch(/google's limit rather than ours/);
      expect(GOOGLE_TEXT).toMatch(/closes most of the gap/);
      expect(GOOGLE_TEXT).toMatch(/about 30 days/);
      for (const overclaim of [
        /every meeting (?:in|on|from) your (?:team|workspace|organi[sz]ation)/,
        /all (?:your )?(?:past |team )?meetings/,
        /every meeting you (?:attend|are invited to)/,
      ]) {
        expect({ overclaim: overclaim.source, found: overclaim.test(GOOGLE_TEXT) }).toEqual({ overclaim: overclaim.source, found: false });
      }
    }
  });

  it("carries no attestation checkbox, and a disconnect note that promises no certain revoke", () => {
    for (const { copy: GOOGLE_COPY, text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_COPY.consentCheckbox).toBeUndefined();
      expect(GOOGLE_TEXT).not.toContain("i understand that");
      const note = normalize(GOOGLE_COPY.disconnectNote ?? "");
      expect(note).toMatch(/asks google to revoke/);
      expect(note).toMatch(/instead of pretending the revoke worked/);
      expect(note).toMatch(/remove tinychat yourself/);
      for (const overpromise of [/\brevocation is (?:immediate|instant)/, /\balways revokes\b/, /\bguarantees? (?:the )?revoke/]) {
        expect({ overpromise: overpromise.source, found: overpromise.test(note) }).toEqual({ overpromise: overpromise.source, found: false });
      }
    }
  });

  it("keeps the testing-mode re-auth caveat out of the always-on copy, and honest in itself", () => {
    const caveat = normalize(GOOGLE_TESTING_MODE_REAUTH_COPY);
    expect(caveat).toMatch(/7 days/);
    expect(caveat).toMatch(/reconnect/);
    expect(caveat).toMatch(/syncing pauses/);
    expect(caveat).toMatch(/already in your space are unaffected/);
    for (const { text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_TEXT).not.toContain("7 days");
    }
  });

  it("does not disturb the two background-sync texts", () => {
    for (const { text: GOOGLE_TEXT } of selectable(GOOGLE_MEET_CONSENT_COPY, "both")) {
      expect(GOOGLE_TEXT).not.toContain("fireflies");
    }
    for (const base of [BACKGROUND_SYNC_CONSENT_COPY, BACKEND_INGEST_CONSENT_COPY]) {
      for (const { text } of selectable(base)) expect(text).not.toContain("google");
    }
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
    expect(doc).toMatch(new RegExp(`\\*\\*${RETENTION_WINDOW_DAYS} days\\*\\*`));
    expect(doc).toMatch(/deletes the stored\s+meetings and the credential/i);
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
