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
import { makeSignedTranscriptGrant, type SignedTranscriptGrant } from "./helpers/transcript-grant.js";
import * as consentCopyModule from "../../../frontend/src/lib/connectors/consentCopy";
import {
  BACKEND_INGEST_CONSENT_COPY,
  BACKGROUND_SYNC_CONSENT_COPY,
  GOOGLE_CALENDAR_AUTOJOIN_CONSENT_COPY,
  GOOGLE_MEET_CONSENT_COPY,
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
