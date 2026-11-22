import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * W9 — **Gate 5: provider + surface hardening** (backend-ingest plan §10; §8.1 W9).
 *
 * **The Gate 5 checklist is an artifact, not a feeling.** Plan §4 says every gate exits with a
 * written artifact; §10 lists six items. The checklist file has to name each one and point at
 * evidence that actually exists — a checklist citing a deleted test is worse than no
 * checklist.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CHECKLIST = resolve(REPO_ROOT, "docs/connector-webhooks-gate5-checklist.md");

// ── 2. The gate's written artifact ───────────────────────────────────

describe("W9 / Gate 5 — the checklist artifact", () => {
  test("every §10 item is on the checklist, with a verdict", () => {
    expect(existsSync(CHECKLIST)).toBe(true);
    const doc = readFileSync(CHECKLIST, "utf8");

    for (const item of [
      "2xx < 10 s",
      "X-Hub-Signature",
      "V-b",
      "Owns-only",
      "Host-header allowlist",
      "Accept-path defense-in-depth",
    ]) {
      expect({ item, present: doc.includes(item) }).toEqual({
        item,
        present: true,
      });
    }
  });

  test("every evidence path the checklist cites actually exists", () => {
    const doc = readFileSync(CHECKLIST, "utf8");
    const cited = [...doc.matchAll(/`((?:backend|frontend|docs)\/[\w./-]+)`/g)].map(
      (match) => match[1],
    );

    // A checklist with no citations would pass a "no broken citation" test vacuously.
    expect(cited.length).toBeGreaterThanOrEqual(6);
    for (const path of new Set(cited)) {
      expect({ path, exists: existsSync(resolve(REPO_ROOT, path)) }).toEqual({
        path,
        exists: true,
      });
    }
  });

  test("the checklist records the V-b verdict and the amendment that closed it, not a hope", () => {
    const doc = readFileSync(CHECKLIST, "utf8");

    // DECISIONS records V-b as `risk-deferred`: the derived secret was 43 chars against a 16–32
    // char provider field. The checklist has to say what was DONE about it.
    expect(doc).toContain("16–32");
    expect(doc).toContain("43");
    expect(doc).toContain("risk-deferred");
    expect(doc).toContain("backend/src/__tests__/webhook-secret-length.test.ts");
  });

  test("owns-only is recorded, and no shipped consent sentence promises team-wide capture", () => {
    const doc = readFileSync(CHECKLIST, "utf8");
    // §10: normal Fireflies webhooks fire only for meetings the USER OWNS; team-wide capture
    // needs Enterprise. It bounds what "always there" can honestly promise, so it is written down
    // where the promise is made…
    expect(doc).toMatch(/owns/i);
    expect(doc).toContain("Enterprise");

    // …and the shipped copy is checked against it, negatively: nothing may imply every meeting a
    // user is merely invited to.
    const copy = readFileSync(
      resolve(REPO_ROOT, "frontend/src/lib/connectors/consentCopy.ts"),
      "utf8",
    );
    for (const overclaim of [
      /every meeting (?:in|on|from) your (?:team|workspace|organi[sz]ation)/i,
      /all (?:your )?team meetings/i,
      /team-wide/i,
      /everyone'?s meetings/i,
    ]) {
      expect({ overclaim: overclaim.source, found: overclaim.test(copy) }).toEqual({
        overclaim: overclaim.source,
        found: false,
      });
    }
  });

  test("it does not claim the host allowlist is an authentication boundary", () => {
    const doc = readFileSync(CHECKLIST, "utf8");
    // The HMAC is the boundary; the ingress hop count is UNDETERMINED
    // (docs/connector-webhooks-trust-proxy.md). Overclaiming here is how a control gets trusted
    // for something it cannot do.
    expect(doc).toMatch(/not an authentication boundary/i);
    expect(doc).toContain("docs/connector-webhooks-trust-proxy.md");
  });
});
