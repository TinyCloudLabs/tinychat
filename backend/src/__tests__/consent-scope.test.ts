import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MANIFEST_SPACE } from "@tinycloud/node-sdk/core";
import { APP_ID, type ServerInfoPermission } from "@tinyboilerplate/core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { backendDelegationResolvedPermissions } from "../manifest.js";
import { verifyTranscriptWriterGrant } from "../delegation-verify.js";
import { activateVerifiedDelegation } from "../portable-delegation.js";
import { makeSignedTranscriptGrant } from "./helpers/transcript-grant.js";

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
