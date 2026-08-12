import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MANIFEST_SPACE } from "@tinycloud/node-sdk/core";
import type { ServerInfoPermission } from "@tinyboilerplate/core";
import { APP_ID, THREADS_KV_PREFIX, backendDelegationResolvedPermissions } from "../manifest.js";
import { activatePortableDelegation } from "../portable-delegation.js";
import { RETENTION_WINDOW_DAYS } from "../services/content-store.js";
import {
  BACKEND_INGEST_CONSENT_COPY,
  BACKGROUND_SYNC_CONSENT_COPY,
  consentCopyText,
} from "../../../frontend/src/lib/connectors/consentCopy";

/**
 * Consent/scope agreement (build task B2, §3.2/§3.8) — re-pointed at the SELECTED product.
 *
 * Operator decision 2026-08-04: **ingest shape C**. The server queues meeting ids, never receives
 * the Fireflies API key, never writes meeting content, and holds **no connector delegation**. So
 * the copy no longer describes a grant, and the job of this file changes shape with it:
 *
 *  - the backend policy must stay at v1's non-connector scope — no connector SQL/KV/secrets entry
 *    may appear, ever, and a widening fails here before it reaches a user;
 *  - the shipped copy must be C's, must claim no permission, and must carry no consent checkbox
 *    (Option B's checkbox is deleted from the bundle, not left dormant to drift);
 *  - the confinement deny-list stays exactly as it was. It is not conditional on there being a
 *    grant: a sentence asserting a permission cannot reach something is unprovable while
 *    `V3_VERDICT.json` records the escape, whichever option ships.
 *
 * INGEST-CUTOVER(plan §11) — Gate 6 landed and this file now covers TWO products. Backend
 * ingestion (`CONNECTOR_BACKEND_INGEST_ENABLED` + the per-address cohort) retires two shipped
 * sentences for cohort users: the server DOES hold a Fireflies credential and it DOES receive the
 * meeting. What it does NOT do is mint a connector delegation — custody is out of band (plan §6,
 * §9 row 3) — so every scope assertion below survives the reversal and is kept as an explicit
 * regression guard rather than deleted. The copy assertions are the ones that were factually
 * false for a cohort user; they are scoped to the non-cohort text, and the cohort text's own
 * claims are asserted positively in "the cohort consent copy tells the new truth".
 *
 * The Option-B grant is kept below as `REJECTED_OPTION_B_GRANT` — the thing C declined to mint.
 * The ability-semantics pins read against it because they are *why* the deny-list exists, and
 * because resurrecting the grant has to break them rather than pass quietly.
 *
 * Two things this test deliberately does NOT do, because doing them was the original defect
 * (§0a re-specified this task):
 *
 *  1. It does not inspect action strings. "No entry carries `del`" reads the KV list only and
 *     passes green over `tinycloud.sql/write`, which authorizes `Delete` AND the whole DDL arm
 *     including `DROP TABLE` (§3.2b). The assertion is against the ability → SQLite
 *     `AuthAction` table below, mined from the node authorizer.
 *  2. It does not treat a path assertion as a confinement proof. "No entry's path lies outside
 *     `connectors`" is a fact about what we ASK FOR. The node resolves an extended path's last
 *     segment to a database and the delegatee chooses the extension (§0a), so no inspection of
 *     our own policy can see the escape. Confinement is therefore a CLAIM this test refuses by
 *     default: any sentence asserting the grant cannot reach something fails, unless V3's
 *     checked-in verdict artifact records the node fix as live.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// Owned and written by build task V3; read-only here (residual R4). Absent ⇒ fail, never skip.
const V3_VERDICT_PATH = resolve(__dirname, "../../../test/connectors/fixtures/V3_VERDICT.json");

const BACKEND_DID = "did:key:z6MkConsentScopeProbe";

const COPY = BACKGROUND_SYNC_CONSENT_COPY;
const COPY_TEXT = normalize(consentCopyText(COPY));

// INGEST-CUTOVER(plan §11) — the cohort text, read the same way C's is: normalized and matched
// claim by claim, against the same deny-lists. It is a second product, not a second draft.
const COHORT_COPY = BACKEND_INGEST_CONSENT_COPY;
const COHORT_TEXT = normalize(consentCopyText(COHORT_COPY));

// ---------------------------------------------------------------------------------------------
// The ability → authorized-SQLite-AuthAction table (§3.2b, acceptance half 1).
//
// Mined from `repositories/tinycloud-node/tinycloud-core/src/sql/authorizer.rs` (read against
// the TC-119 registry-aware revision; the comments there state the gates are identical to the
// `admin | write | *` and `write | schema | *` sets the finding was written against):
//
//   can_write_data(ability, is_admin) = is_admin || ability_matches(ability, "tinycloud.sql/write")
//   Insert | Delete            → can_write_table(...)                       (so `write` deletes)
//   Update                     → can_write_table(...)
//   CreateTable | DropTable | AlterTable | CreateIndex | DropIndex | CreateTrigger | DropTrigger
//     | CreateView | DropView | Reindex | …temp variants
//                              → is_admin || matches `write` || matches `schema`
//                                                                  (so `write` DROPs tables, and
//                                                                   withholding `schema` buys
//                                                                   none of what §3.2 claimed)
//   Read | Select | Transaction | Savepoint
//                              → allowed, except for a bare `schema` ability before its DDL
//   Attach | Detach            → always denied
//   everything else            → denied
//
// Caveats are the only table/read-only restriction and default permissive
// (`sql/caveats.rs`: `tables: None ⇒ allowed`, `read_only: None ⇒ writes allowed`), and the
// supported mint path carries no caveats parameter at all — so a delete-free SQL grant does not
// exist today. This table is a pin: if the node changes, V2/V3 re-runs are what update it, and
// the copy assertions below break the build until the copy is corrected with it.
// ---------------------------------------------------------------------------------------------

type AuthAction =
  | "Select"
  | "Read"
  | "Transaction"
  | "Savepoint"
  | "Insert"
  | "Update"
  | "Delete"
  | "CreateTable"
  | "AlterTable"
  | "CreateIndex"
  | "DropIndex"
  | "CreateTrigger"
  | "DropTrigger"
  | "CreateView"
  | "DropView"
  | "DropTable"
  | "Reindex";

const READ_ACTIONS: readonly AuthAction[] = ["Select", "Read", "Transaction", "Savepoint"];
const DATA_WRITE_ACTIONS: readonly AuthAction[] = ["Insert", "Update", "Delete"];
const DDL_ACTIONS: readonly AuthAction[] = [
  "CreateTable",
  "DropTable",
  "AlterTable",
  "CreateIndex",
  "DropIndex",
  "CreateTrigger",
  "DropTrigger",
  "CreateView",
  "DropView",
  "Reindex",
];

const SQL_ABILITY_AUTH_ACTIONS: Record<string, readonly AuthAction[]> = {
  "tinycloud.sql/read": READ_ACTIONS,
  "tinycloud.sql/write": [...READ_ACTIONS, ...DATA_WRITE_ACTIONS, ...DDL_ACTIONS],
  // `schema` reaches the DDL arm and the sqlite schema tables, not the app's rows.
  "tinycloud.sql/schema": DDL_ACTIONS,
  "tinycloud.sql/admin": [...READ_ACTIONS, ...DATA_WRITE_ACTIONS, ...DDL_ACTIONS],
  "tinycloud.sql/*": [...READ_ACTIONS, ...DATA_WRITE_ACTIONS, ...DDL_ACTIONS],
};

/** Removing data the user did not ask us to remove. What "cannot delete" would have to deny. */
const DESTRUCTIVE_ACTIONS: readonly AuthAction[] = [
  "Delete",
  "Update",
  "DropTable",
  "AlterTable",
  "DropIndex",
  "DropTrigger",
  "DropView",
];

/**
 * `SqlRequest::Export` is dispatched by the service before the per-statement authorizer runs and
 * is not gated on an ability (`sql/database.rs` — the authorizer never sees it). So ANY SQL
 * ability, read included, yields a full binary copy of the resolved database, and a copy that
 * names a SQL permission must disclose bulk export.
 */
const SQL_EXPORT_IS_ABILITY_GATED = false;

/** Bulk export follows the SQL grant itself, not the ability on it. */
function exportIsReachable(scope: readonly ServerInfoPermission[]): boolean {
  return scope.some(
    (entry) =>
      entry.service === "tinycloud.sql" &&
      (SQL_EXPORT_IS_ABILITY_GATED ? selectedSqlAbility(entry.actions) !== undefined : true),
  );
}

/** Ability selection at the node is highest-privilege-first: `[read,write]` IS `write`. */
const SQL_ABILITY_PRECEDENCE = [
  "tinycloud.sql/*",
  "tinycloud.sql/admin",
  "tinycloud.sql/write",
  "tinycloud.sql/schema",
  "tinycloud.sql/read",
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
// The grant the shipped copy describes, and the scope the backend actually activates.
// ---------------------------------------------------------------------------------------------

/**
 * The §3.2 connectors policy — the grant Option B's consent checkbox would have minted, resolved
 * to the paths the node sees. **Option C declines it.** Nothing in the shipped product asks for
 * it; it stays here as the counterfactual the ability-semantics pins read against, and as the
 * shape `scopeState` refuses if it ever turns up in the activated policy.
 */
const REJECTED_OPTION_B_GRANT: readonly ServerInfoPermission[] = [
  {
    service: "tinycloud.sql",
    space: DEFAULT_MANIFEST_SPACE,
    path: `${APP_ID}/connectors`,
    actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
  },
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE,
    path: `${APP_ID}/connectors/`,
    actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
  },
];

/** v1's untouched backend policy — under Option C this is the FINAL shape, not an interim one. */
const V1_NON_CONNECTOR_SCOPE: readonly ServerInfoPermission[] = [
  {
    service: "tinycloud.kv",
    space: DEFAULT_MANIFEST_SPACE,
    path: THREADS_KV_PREFIX,
    actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"],
  },
];

/** The Option-C truth pass: the records that must describe the selected product, not a prototype. */
const DELEGATION_GATE_DOC = resolve(__dirname, "../../../docs/connector-webhooks-delegation-gate.md");
const DEPLOYMENT_DOC = resolve(__dirname, "../../../docs/deployment.md");
const RESIDUALS_DOC = resolve(__dirname, "../../../docs/connector-webhooks-p1-residuals.md");

/**
 * INGEST-CUTOVER(plan §11) — the operator-facing mirror of the cohort copy. It exists so the text
 * approved at Gate 6 and the text the product would render cannot decouple: the fidelity test
 * below parses it and compares field for field against `BACKEND_INGEST_CONSENT_COPY`.
 */
const COHORT_COPY_DOC = resolve(
  __dirname,
  "../../../docs/connector-webhooks-backend-ingest-consent-copy.md",
);

/** The one renderer of consent copy — read as SOURCE, because what it renders is the finding. */
const CONSENT_RENDERER = resolve(
  __dirname,
  "../../../frontend/src/chat/BackgroundSyncSection.tsx",
);

function readDoc(path: string): string {
  if (!existsSync(path)) throw new Error(`Missing record: ${path}`);
  return readFileSync(path, "utf-8");
}

/**
 * Parse the approval mirror: `## <field>` followed by a single blockquote paragraph. Line wrapping
 * is the doc's own, so whitespace is collapsed on both sides before comparison — every other
 * character, including the `**bold**` markers that are part of the copy, must match exactly.
 */
function parseApprovedCopy(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let current: string | null = null;

  for (const line of markdown.split("\n")) {
    const headed = /^## (.+?)\s*$/.exec(line);
    if (headed) {
      current = headed[1];
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("> ")) {
      fields[current] = `${fields[current] ?? ""} ${line.slice(2).trim()}`.trim();
    }
  }

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, value.replace(/\s+/g, " ").trim()]),
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every action we could plausibly be handed, per service — the overbroad grant we clamp. */
const OVERBROAD_ACTIONS: Record<string, readonly string[]> = {
  "tinycloud.kv": ["get", "put", "del", "list"],
  "tinycloud.sql": ["read", "write", "schema", "admin"],
  "tinycloud.duckdb": ["read", "write", "schema", "admin"],
  "tinycloud.capabilities": ["read", "write"],
};

/**
 * The ACTIVATED scope, not the policy (§3.2a): a maximal grant run through
 * `activatePortableDelegation`'s clamp, recorded as the node would see it. The two coincide only
 * while S2d's clamp is intact, and noticing when they stop coinciding is this test's job.
 */
async function activatedScope(): Promise<ServerInfoPermission[]> {
  const policy = backendDelegationResolvedPermissions(BACKEND_DID);
  const activated: ServerInfoPermission[] = [];
  const node = {
    // `activateResource` sends one `useDelegation` per activated resource, with the service and
    // space on `resources[0]` and the clamped path/actions hoisted to the top level.
    useDelegation: async (delegation: {
      path: string;
      actions: string[];
      resources?: Array<{ service: string; space?: string }>;
    }) => {
      activated.push({
        service: delegation.resources?.[0]?.service ?? "",
        space: delegation.resources?.[0]?.space,
        path: delegation.path,
        actions: [...delegation.actions],
      });
      return { kv: {}, sql: {} };
    },
  };

  const granted = policy.map((entry) => ({
    service: entry.service,
    space: entry.space,
    // A space-root path: the broadest thing a mint could hand us for this service.
    path: "",
    actions: [...(OVERBROAD_ACTIONS[entry.service] ?? entry.actions)],
  }));

  await activatePortableDelegation(
    node as never,
    { expiry: new Date(Date.now() + 60_000), resources: granted } as never,
    { policy },
  );

  return activated;
}

// ---------------------------------------------------------------------------------------------
// Claim patterns.
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

function normalize(text: string): string {
  return text
    .replace(/[*_`]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matched(
  claims: ReadonlyArray<{ pattern: RegExp; label: string }>,
  text: string,
): string[] {
  return claims.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
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

/**
 * Fail CLOSED. A missing artifact is not "unknown, so allow the confinement sentence" — it is a
 * build that deleted the evidence the sentence depends on.
 */
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

describe("ability semantics — what the granted SQL ability actually authorizes (§3.2b)", () => {
  it("pins `write` to the delete and DDL arms of the node authorizer", () => {
    const write = SQL_ABILITY_AUTH_ACTIONS["tinycloud.sql/write"]!;

    expect(write).toContain("Delete");
    expect(write).toContain("Update");
    expect(write).toContain("DropTable");
    expect(write).toContain("AlterTable");
    expect(write).toContain("Select");
  });

  it("pins `read` to the read arm only", () => {
    const read = SQL_ABILITY_AUTH_ACTIONS["tinycloud.sql/read"]!;

    expect(read).toEqual(READ_ACTIONS);
    expect(read).not.toContain("Delete");
    expect(read).not.toContain("DropTable");
  });

  it("selects the highest-privilege ability: `[read,write]` is `write`", () => {
    expect(selectedSqlAbility(["tinycloud.sql/read", "tinycloud.sql/write"])).toBe(
      "tinycloud.sql/write",
    );
    expect(selectedSqlAbility(["tinycloud.sql/write", "tinycloud.sql/read"])).toBe(
      "tinycloud.sql/write",
    );
    expect(selectedSqlAbility(["tinycloud.sql/read"])).toBe("tinycloud.sql/read");
  });

  // This is the whole reason B2 was re-specified. The string-level check reads green on exactly
  // the scope that authorizes deletion; the semantic check does not.
  it("is not a string check: a `del`-free action list still authorizes Delete and DROP TABLE", () => {
    const actionStrings = REJECTED_OPTION_B_GRANT.flatMap((entry) => entry.actions);
    expect(actionStrings.some((action) => action.endsWith("/del"))).toBe(false);

    const authorized = authorizedAuthActions(REJECTED_OPTION_B_GRANT);
    expect(authorized.has("Delete")).toBe(true);
    expect(authorized.has("DropTable")).toBe(true);
  });

  it("treats bulk export as reachable under any SQL ability, read included", () => {
    expect(SQL_EXPORT_IS_ABILITY_GATED).toBe(false);
    expect(
      exportIsReachable([
        { service: "tinycloud.sql", path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read"] },
      ]),
    ).toBe(true);
    expect(
      exportIsReachable(REJECTED_OPTION_B_GRANT),
    ).toBe(true);
    expect(
      exportIsReachable([
        { service: "tinycloud.kv", path: `${APP_ID}/connectors/`, actions: ["tinycloud.kv/get"] },
      ]),
    ).toBe(false);
  });
});

describe("activated scope (§3.2a — the clamp's output, not the policy)", () => {
  // INGEST-CUTOVER(plan §11) — re-rationalized, not relaxed. The clamp check is unchanged and
  // still passes: backend ingestion (plan §5, §9 row 3) takes custody OUT OF BAND and mints no
  // connector delegation, so the activated scope is the same v1 shape for a cohort address as
  // for anyone else. What changed is why this matters — a widening here would now mean the
  // reversal went further than the operator signed (DECISIONS D1/D2), not merely that the copy
  // drifted.
  it("activates exactly the resolved backend policy under a space-root grant", async () => {
    const policy = backendDelegationResolvedPermissions(BACKEND_DID);
    const activated = await activatedScope();

    // A service in the policy that this test has no overbroad-action list for would silently
    // weaken the clamp probe above.
    for (const entry of policy) expect(Object.keys(OVERBROAD_ACTIONS)).toContain(entry.service);

    expect(sortScope(activated)).toEqual(sortScope(policy));
  });

  // INGEST-CUTOVER(plan §11) — converted from an Option-C-only statement into a REGRESSION GUARD
  // that outlives the cutover. There is still exactly ONE acceptable shape: v1's non-connector
  // policy. It holds for a non-cohort address because Option C mints nothing, and it holds for a
  // COHORT address because backend ingestion reads Fireflies with a credential the server holds
  // out of band (plan §6) and writes meetings into its OWN store, never the user's space (plan
  // §5, §9 row 3). Neither mode has a reason to widen this policy, so a widening is a defect in
  // either — and the marker is here so a future reader does not mistake the guard for a leftover.
  it("is exactly v1's non-connector policy — neither mode mints a connector delegation", async () => {
    const activated = sortScope(await activatedScope());
    const state = scopeState(activated);

    if (state !== "v1-non-connector") {
      throw new Error(
        `The activated backend scope is not v1's non-connector policy: ` +
          `${JSON.stringify(activated)}. Neither shipped mode holds a connector delegation: ` +
          `Option C queues ids only (operator decision 2026-08-04), and backend ingestion ` +
          `(plan §9 row 3) keeps custody out of band precisely so no new grant into a user's ` +
          `space is needed. Widening the policy contradicts BOTH consent texts, each of which ` +
          `tells the user no permission on their space is granted.`,
      );
    }
    expect(state).toBe("v1-non-connector");
  });

  // INGEST-CUTOVER(plan §11) — same disposition: still factually true, kept as a regression
  // guard, and load-bearing in a NEW way. Under backend ingestion the server already holds the
  // Fireflies credential and the meeting; a connector SQL/KV/secrets entry appearing here would
  // add standing write access to the user's own space on top of that — the Listen shape plan §9
  // row 3 excludes, and a strictly larger reversal than the one the operator signed.
  it("carries no connector SQL, KV or secrets entry at all", async () => {
    const activated = await activatedScope();

    for (const entry of activated) {
      expect(entry.path.startsWith(`${APP_ID}/connectors`)).toBe(false);
      expect(entry.service).not.toBe("tinycloud.sql");
      expect(entry.service).not.toBe("tinycloud.secrets");
    }
    // The connectors ability set neither copy discloses is authorized nowhere.
    expect(authorizedAuthActions(activated).size).toBe(0);
    expect(exportIsReachable(activated)).toBe(false);
  });
});

describe("consent copy agrees with the unchanged backend policy (§3.8)", () => {
  // INGEST-CUTOVER(plan §11) — regression guard, with the rationale corrected. C is still the
  // text a NON-COHORT user reads and plan §5.3 requires that path to stay byte-identical, so
  // `COPY.variant === "C"` stays pinned. `connectorEntries === []` is now the shared invariant of
  // BOTH texts: C says no permission is granted because nothing is asked for, and the cohort text
  // says the credential our server holds sits OUTSIDE the user's space. Either sentence becomes a
  // lie the moment a connector entry appears here.
  it("ships C to non-cohort users, over a policy holding no connector grant", async () => {
    const activated = await activatedScope();
    const connectorEntries = activated.filter((entry) =>
      entry.path.startsWith(`${APP_ID}/connectors`),
    );

    // The invariant is NOT "the policy is empty" — the backend keeps v1's unrelated chat-threads
    // grant under C, and coupling the two is the defect this build removed. It is "no connector
    // grant exists", which is exactly what both copies tell the user.
    expect(connectorEntries).toEqual([]);
    expect(COPY.variant).toBe("C");
    expect(COHORT_COPY.variant).toBe("B-ingest");
  });

  it("carries no consent checkbox — Option B's is deleted, not left dormant", () => {
    expect("checkbox" in COPY).toBe(false);
    expect(COPY_TEXT).not.toContain("i understand that");
    // INGEST-CUTOVER(plan §11) — the interface now HAS an optional `consentCheckbox`, for the
    // cohort variant's attestation. Option C must still carry none: under C nothing is granted
    // and nothing is held, so there is nothing to attest to, and a dormant string here would be
    // an invitation to render a consent gate for a grant that does not exist.
    expect(COPY.consentCheckbox).toBeUndefined();
    expect(COPY.disconnectNote).toBeUndefined();
  });

  it("makes no grant claim, because no grant is minted", () => {
    // Every sentence Option B needed to disclose its permission is gone WITH the permission.
    expect(COPY_TEXT).not.toContain("standing permission");
    expect(COPY_TEXT).not.toContain("what that permission can technically do");
    expect(COPY_TEXT).not.toContain("including your chats");
    expect(COPY_TEXT).not.toContain("expires after 7 days");
    expect(COPY_TEXT).not.toContain("we ask for it on your connectors data");

    // …and it says so positively, so the absence is a statement rather than an omission.
    expect(COPY_TEXT).toContain("no new permission");
  });

  /**
   * INGEST-CUTOVER(plan §11) — W10 landed, and this is the disposition it chose.
   *
   * The two custody sentences are NOT permanent invariants and are no longer written as if they
   * were. They are scoped: they describe what a NON-COHORT user is told, on the path plan §5.3
   * requires to stay byte-identical, and they stay pinned so nobody quietly weakens Option C
   * while changing the cohort. For a cohort address both sentences are FALSE — the server holds
   * the credential and receives the meeting — and the cohort text says so; that is asserted
   * positively below in "the cohort consent copy tells the new truth", not by deleting anything
   * here.
   */
  it("keeps Option C's custody sentences for the non-cohort user", () => {
    expect(COPY.variant).toBe("C");
    expect(COPY_TEXT).toContain("which meetings are ready");
    expect(COPY_TEXT).toContain("never sees your fireflies key");
    // Content: on the Option C path the server queues ids and times, and that is all it gets.
    expect(COPY_TEXT).toContain("it never receives the meeting itself");
  });

  it("says plainly that this is not fully-offline ingestion", () => {
    expect(COPY_TEXT).toContain("this is not fully-offline ingestion");
    expect(COPY_TEXT).toContain("your next visit");
    // No promise that meetings arrive while the app is closed — only the notification does.
    expect(COPY_TEXT).not.toContain("even while tinychat is closed the meeting");
  });

  it("carries no confinement claim while V3 records the escape reproducing", () => {
    const { escapeReproduces } = readV3Verdict();
    const found = matched(CONFINEMENT_CLAIMS, COPY_TEXT);

    // Unconditional under C too: dropping the grant does not license a sentence about what a
    // permission cannot reach. Only a node fix recorded in V3's artifact would.
    expect(escapeReproduces ? found : []).toEqual([]);
  });

  it("makes no delete-capability claim either", () => {
    // The rejected grant is what the deny-list is calibrated against: `sql/write` authorizes
    // Delete and DropTable, so "cannot delete" was never sayable — and C, holding nothing at
    // all, has no reason to reach for it.
    const authorized = authorizedAuthActions(REJECTED_OPTION_B_GRANT);
    expect(DESTRUCTIVE_ACTIONS.filter((action) => authorized.has(action)).length).toBeGreaterThan(
      0,
    );
    expect(matched(DELETE_CAPABILITY_CLAIMS, COPY_TEXT)).toEqual([]);
  });

  it("discloses the publicly readable operational log (§6.3 / T13)", () => {
    // Survives the option change untouched: the log is written by the webhook route and the
    // queue, which no delegation gates, so dropping the grant does not drop this disclosure.
    expect(COPY_TEXT).toContain("publicly readable");
    expect(COPY_TEXT).toContain("scrambled stand-ins");
  });

  it("still warns that the delivery URL is a credential", () => {
    expect(COPY_TEXT).toContain("like a password");
  });
});

/**
 * INGEST-CUTOVER(plan §11) — the cohort consent copy, checked against plan §11's four
 * requirements. This is the block that makes the reversal honest: the assertions above pin what a
 * non-cohort user is still told, and these pin that a cohort user is told the opposite where the
 * opposite is true, in the copy's own words rather than by an omission.
 */
describe("the cohort consent copy tells the new truth (plan §11 requirements 1-4)", () => {
  // Requirement 4 — every "never sees your key / never receives the meeting" formulation is GONE
  // for cohort users. Not softened, not qualified: absent, because for them it is false.
  it("carries no 'never sees your key' / 'never receives the meeting' formulation", () => {
    expect(COHORT_TEXT).not.toContain("never sees your fireflies key");
    expect(COHORT_TEXT).not.toContain("never receives the meeting");
    for (const stale of [
      /\bnever (?:sees|saw|receives|received|holds|stores) your (?:fireflies )?(?:api )?key\b/,
      /\bthe key stays where it is today\b/,
      /\bonly your browser reads it\b/,
      /\bnever writes? (?:a )?meeting content\b/,
    ]) {
      expect({ stale: stale.source, found: stale.test(COHORT_TEXT) }).toEqual({
        stale: stale.source,
        found: false,
      });
    }
  });

  // Requirement 1 — the credential is named, its kind is named (DECISIONS `V-a-branch: b1` =
  // OAuth: revocable, expiring, per-user), and — because Fireflies publishes no data scope, so
  // every branch is full-account — what it could do if breached is stated rather than implied.
  // That last clause is the operator's signed blast-radius acceptance, said out loud to the user.
  it("says the server holds a Fireflies credential, and what it could do if breached", () => {
    expect(COHORT_TEXT).toContain("fireflies credential");
    expect(COHORT_TEXT).toContain("oauth token");
    expect(COHORT_TEXT).toMatch(/no read-only permission/);
    // The full-account reach, itemized: read is not the whole of it.
    expect(COHORT_TEXT).toMatch(/\bdelete them\b/);
    expect(COHORT_TEXT).toMatch(/\breshare\b/);
    expect(COHORT_TEXT).toMatch(/if our server is breached/);
    // …and the bound that makes b1 the least-bad custody: revocation and expiry.
    expect(COHORT_TEXT).toMatch(/revoked? or expires/);
    expect(COHORT_TEXT).toContain("revoke");
  });

  // Requirement 2 — server-side storage, encrypted, for the D2a window, deleted on
  // disconnect/purge. The window is pinned to the code constant, so a retention change that
  // forgets the copy fails here rather than shipping a stale promise.
  it("says the meeting is stored server-side, encrypted, for the D2a window, and deleted", () => {
    expect(RETENTION_WINDOW_DAYS).toBe(90);
    expect(COHORT_TEXT).toContain("keeps its own copy");
    expect(COHORT_TEXT).toContain("encrypted at rest");
    expect(COHORT_TEXT).toContain(`${RETENTION_WINDOW_DAYS} days`);
    expect(COHORT_TEXT).toMatch(/disconnecting[^.]*deletes the stored meetings/);
    expect(COHORT_TEXT).toContain("purge");
  });

  // Requirement 3, first half — no confinement claim. The deny-list is NOT relaxed for the
  // cohort: the INTERNAL escape (§3 item 3) is what forbids these sentences, and holding the
  // credential server-side does not patch a node.
  it("makes no confinement claim while V3 records the escape reproducing", () => {
    const { escapeReproduces } = readV3Verdict();
    expect(escapeReproduces ? matched(CONFINEMENT_CLAIMS, COHORT_TEXT) : []).toEqual([]);
    expect(matched(DELETE_CAPABILITY_CLAIMS, COHORT_TEXT)).toEqual([]);
  });

  // Requirement 3, second half — owns-only (plan §10). Fireflies fires for meetings the user
  // OWNS; capture across an account needs Enterprise. The copy must promise the smaller thing.
  it("promises only the meetings the user owns", () => {
    expect(COHORT_TEXT).toMatch(/the meetings you own/);
    expect(COHORT_TEXT).toMatch(/owned by someone else[^.]*is not sent to us/);
    for (const overclaim of [
      /every meeting (?:in|on|from) your (?:team|workspace|organi[sz]ation)/,
      /all (?:your )?team meetings/,
      /every meeting you (?:attend|are invited to)/,
      /everyone'?s meetings/,
    ]) {
      expect({ overclaim: overclaim.source, found: overclaim.test(COHORT_TEXT) }).toEqual({
        overclaim: overclaim.source,
        found: false,
      });
    }
  });

  // The one Option-C sentence that survives into the cohort text, and it survives because it is
  // still checked against the real policy on every run: B mints no connector delegation (§9 row
  // 3), so "no new permission on your space" is a fact, not a reassurance.
  it("still says no new permission on the user's space, and the policy agrees", async () => {
    const activated = await activatedScope();

    expect(COHORT_TEXT).toContain("no new permission");
    expect(COHORT_TEXT).toContain("outside your space");
    expect(
      activated.filter((entry) => entry.path.startsWith(`${APP_ID}/connectors`)),
    ).toEqual([]);
  });

  // The disclosures that are true in both modes stay in both texts — a rewrite is not a licence
  // to drop the operational-log or delivery-URL warnings.
  it("keeps the disclosures that survive the mode change", () => {
    expect(COHORT_TEXT).toContain("publicly readable");
    expect(COHORT_TEXT).toContain("scrambled stand-ins");
    expect(COHORT_TEXT).toContain("like a password");
  });

  /**
   * INGEST-CUTOVER(plan §11) — requirement 2, the half the first cut of this copy smoothed.
   *
   * `services/connector-teardown.ts` deletes the credential row unconditionally but carries a
   * FAILED upstream revoke out as a value (`upstreamRevoked: false` + `reason`) rather than
   * swallowing it, because the provider-side grant may still be live. Revocation-and-expiry is
   * the ONLY bound on the signed blast-radius acceptance, so a copy that states revocation as an
   * unconditional fact is the one caveat the user most needs, missing. Pinned in the same shape
   * as the retention pin: smoothing it later fails the build.
   */
  it("says what happens when the upstream revoke fails, rather than promising it always works", () => {
    expect(COHORT_TEXT).toMatch(/if that upstream revoke fails we tell you so/);
    expect(COHORT_TEXT).toMatch(/we cannot revoke upstream, we tell you so/);
    expect(COHORT_TEXT).toMatch(/instead of pretending it worked/);
    // …and no sentence anywhere that asserts revocation as a completed fact of disconnecting.
    for (const overpromise of [
      /disconnecting here revokes it too\b/,
      /\brevokes the credential with fireflies\b/,
      /\brevocation is (?:immediate|instant)/,
    ]) {
      expect({ overpromise: overpromise.source, found: overpromise.test(COHORT_TEXT) }).toEqual({
        overpromise: overpromise.source,
        found: false,
      });
    }
  });

  // Requirement 1 + 2, as an attestation. Option C has no checkbox because nothing is granted;
  // the cohort variant has two disclosures the user should have to acknowledge in one sentence —
  // the full-account token and the 90-day content copy — and the sentence names both.
  it("carries the attestation checkbox, naming both disclosures", () => {
    expect(COHORT_COPY.consentCheckbox).toBeDefined();
    expect(COHORT_COPY.disconnectNote).toBeDefined();
    const attestation = normalize(COHORT_COPY.consentCheckbox ?? "");
    expect(attestation).toContain("full-account fireflies token");
    expect(attestation).toContain(`${RETENTION_WINDOW_DAYS} days`);
  });

  // The "already there" headline is bounded to W12's actual acceptance criterion — no prior
  // device setup, NOT anonymous access — so the benefit cannot be over-read as public reach.
  it("bounds the 'already there' promise to a signed-in session", () => {
    expect(COHORT_TEXT).toMatch(/signing in is still required/);
    expect(COHORT_TEXT).toMatch(/not mean your meetings are reachable without signing in/);
  });

  /**
   * INGEST-CUTOVER(plan §11) — the approval artifact and the shipped constant are ONE text.
   *
   * The cutover audit found them decoupled: the operator was being asked to approve a variant,
   * a bullet count, a checkbox and a disconnect note that the code did not have. They are now
   * pinned to each other, so an edit to either side without the other fails here rather than
   * shipping words nobody approved.
   */
  it("matches the operator approval artifact sentence for sentence", () => {
    const approved = parseApprovedCopy(readDoc(COHORT_COPY_DOC));

    expect(approved.variant).toBe(COHORT_COPY.variant);
    expect(approved.heading).toBe(collapse(COHORT_COPY.heading));
    expect(approved.intro).toBe(collapse(COHORT_COPY.intro));
    expect(approved.changesHeading).toBe(collapse(COHORT_COPY.changesHeading));
    expect(approved.consentCheckbox).toBe(collapse(COHORT_COPY.consentCheckbox ?? ""));
    expect(approved.disconnectNote).toBe(collapse(COHORT_COPY.disconnectNote ?? ""));

    // Bullet count too: a bullet dropped from the code and left in the artifact is exactly the
    // divergence this test exists for.
    const approvedBullets = Object.keys(approved).filter((key) => key.startsWith("bullet "));
    expect(approvedBullets.length).toBe(COHORT_COPY.bullets.length);
    COHORT_COPY.bullets.forEach((bullet, index) => {
      expect(approved[`bullet ${index + 1}`]).toBe(collapse(bullet));
    });
  });

  /**
   * INGEST-CUTOVER(plan §11) — the cutover audit's blocker, held open honestly.
   *
   * Writing the cohort copy is not showing it. The only renderer,
   * `frontend/src/chat/BackgroundSyncSection.tsx`, is on the frozen drain-UX increment and
   * renders Option C unconditionally, so a cohort address would today read the two sentences
   * §11 requirement 4 retires for them. Unfreezing that file is an operator-approved change, not
   * a build one — so the gap is recorded instead of hidden, and this test keeps the record and
   * the code honest IN BOTH DIRECTIONS: while nothing selects the cohort copy the docs must say
   * so, and the moment something does, the "not wired" language has to go.
   */
  it("records the unwired consent surface as a residual and an operator gate, until it is wired", () => {
    const renderer = readDoc(CONSENT_RENDERER);
    const deployment = readDoc(DEPLOYMENT_DOC);
    const residuals = readDoc(RESIDUALS_DOC);
    const wired = renderer.includes("BACKEND_INGEST_CONSENT_COPY");

    if (!wired) {
      // The renderer still shows Option C to everyone.
      expect(renderer).toContain("BACKGROUND_SYNC_CONSENT_COPY");
      // The deploy doc may not claim the cohort is shown the new text.
      expect(deployment).toMatch(/NOT yet wired/);
      expect(deployment).toMatch(/pre-rollout gate/i);
      expect(residuals).toMatch(/F011/);
      expect(residuals).toMatch(/BACKEND_INGEST_CONSENT_COPY/);
    } else {
      // Wired: the "not yet" record must be retired in the same change, not left to rot.
      expect(deployment).not.toMatch(/NOT yet wired/);
    }
  });
});

describe("the Option-C truth pass — the records describe the selected product", () => {
  it("records Option C as SELECTED, on V4's grounds, not as a blocked prototype", () => {
    const doc = readDoc(DELEGATION_GATE_DOC);
    const status = doc.split("\n").find((line) => line.startsWith("**Status:")) ?? "";

    expect(status).toContain("Option C");
    expect(status).toContain("SELECTED");
    expect(status).not.toContain("BLOCKED on operator action");

    // The grounds: V4's unsigned spaceId echo and the unverified `att`.
    expect(doc).toContain("V4");
    expect(doc).toContain("unsigned");
    expect(doc).toContain("`att`");
    // No forward plan that widens the policy or lands the rejected consent flow.
    expect(doc).not.toContain("inverts its pre-widening assertions automatically");
    expect(doc).toContain("backendDelegationPermissions()");
  });

  // INGEST-CUTOVER(plan §11) — kept as an operator gate, with the V-b half updated to the truth
  // W9's amendment left behind: the mint is now the 32-character prefix (the 43-character form
  // could not be registered at all against Fireflies' 16–32 char field), and the LIVE dashboard
  // registration is still the operator's, still unperformed. The cutover adds a third gate —
  // cohort enable itself — and the doc must not read as if any of them had been run.
  it("names the provider-dashboard registration check as an OPERATOR pre-rollout gate", () => {
    const doc = readDoc(DEPLOYMENT_DOC);

    expect(doc).toContain("32-character");
    expect(doc).toContain("43-character");
    expect(doc).toMatch(/operator pre-rollout gate/i);
    // It has NOT been run. The deploy doc must not read as if it had.
    expect(doc).toMatch(/has not been (?:performed|run)/i);
    expect(doc).not.toMatch(/(?:verified|confirmed) (?:in|against) the (?:real )?fireflies dashboard/i);
    // The flag flip is an operator action; a build that claims to have enabled the cohort is a
    // build that shipped the reversal to real users without the §12 gates.
    expect(doc).toMatch(/flipping the flag is an operator action/i);
  });

  /**
   * INGEST-CUTOVER(plan §11) — rewritten. The deploy doc used to state the "never receives the
   * Fireflies key" role flatly; that sentence is now SCOPED to non-cohort addresses, because for
   * a cohort address it is false. Both halves are asserted: the Option-C sentence must survive
   * with its scope attached (plan §5.3 keeps that path byte-identical), and the cohort paragraph
   * must state the credential, the encrypted server-side copy, the D2a window and the deletion.
   */
  it("describes BOTH server roles in the deploy doc, each scoped to who gets it", () => {
    const doc = readDoc(DEPLOYMENT_DOC);

    expect(doc).toContain("Option C");
    expect(doc).toContain("/api/connectors/webhooks/ack");

    // Half 1 — the Option-C claim, and the scope that keeps it true.
    expect(doc).toMatch(
      /(?:outside the cohort|non-cohort)[\s\S]{0,400}never receives .{0,40}Fireflies (?:API )?key/i,
    );

    // Half 2 — the cohort truth, said in the doc rather than left to the code.
    expect(doc).toMatch(/holds a per-user Fireflies OAuth credential/i);
    expect(doc).toMatch(/full-account/i);
    expect(doc).toMatch(/keeps its own copy/i);
    expect(doc).toMatch(/encrypted under\s+`CONNECTOR_CONTENT_MASTER`/);
    expect(doc).toMatch(new RegExp(`\\*\\*${RETENTION_WINDOW_DAYS} days\\*\\*`));
    expect(doc).toMatch(/deletes the stored\s+meetings and the credential/i);
    // And the invariant that did NOT reverse, so the doc cannot be read as "everything went".
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

function scopeState(
  activated: readonly ServerInfoPermission[],
): "connectors" | "v1-non-connector" | "unrecognized" {
  const key = JSON.stringify(activated);
  if (key === JSON.stringify(sortScope(REJECTED_OPTION_B_GRANT))) return "connectors";
  if (key === JSON.stringify(sortScope(V1_NON_CONNECTOR_SCOPE))) return "v1-non-connector";
  return "unrecognized";
}
