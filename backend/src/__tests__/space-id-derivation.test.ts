import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildSpaceUri, makePkhSpaceId, parseSpaceUri } from "@tinycloud/node-sdk/core";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/connectors/fixtures");

/**
 * Build task V4 (§11, added by §12a residual R10), executed rather than assumed.
 *
 * §9.2's (F)-branch owner-binding control needs TWO things from the SDK, and R10 states plainly
 * that BOTH must be yes or the answer is the escape hatch — escalate ⇒ ship Option C or hold
 * Phase 2 — never a weaker probe:
 *
 *   1. a deterministic `did:pkh → spaceId` derivation callable in-process, so the comparand is
 *      DERIVED from the authenticated session rather than fetched from any endpoint; and
 *   2. the space id the freshly activated `DelegatedAccess` actually RESOLVED to.
 *
 * These tests pin both answers so a future SDK bump that changes either one fails here rather
 * than silently invalidating `test/connectors/fixtures/V4_VERDICT.json`.
 */
describe("V4 — space-id derivation probe (§9.2 (F) / §12a R10)", () => {
  const ADDRESS = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

  it("half 1 YES: node-sdk exposes a deterministic, in-process did:pkh → spaceId derivation", () => {
    const derived = makePkhSpaceId(ADDRESS, 1, "applications");
    expect(derived).toBe(
      "tinycloud:pkh:eip155:1:0xabCDeF0123456789AbcdEf0123456789aBCDEF01:applications",
    );

    // Deterministic, and address case is canonicalized on the way in — so a session address
    // stored lowercase and one stored checksummed derive the SAME id. That matters: the control
    // is an EXACT-equality check, and a case-sensitive comparand would fail open or fail closed
    // depending on where the address had been round-tripped.
    expect(makePkhSpaceId(ADDRESS.toLowerCase(), 1, "applications")).toBe(derived);
    expect(makePkhSpaceId(ADDRESS.toUpperCase().replace("0X", "0x"), 1, "applications")).toBe(
      derived,
    );

    // Same value from the DID form the session already holds, and it round-trips.
    expect(buildSpaceUri(`did:pkh:eip155:1:${ADDRESS}`, "applications")).toBe(derived);
    expect(parseSpaceUri(derived)).toMatchObject({
      owner: "did:pkh:eip155:1:0xabCDeF0123456789AbcdEf0123456789aBCDEF01",
      name: "applications",
    });

    // Pure: no session, no network, no node — this call is the whole derivation.
    expect(() => makePkhSpaceId(ADDRESS, 1, "")).toThrow();
  });

  it("half 2 NO: DelegatedAccess.spaceId is an ECHO of the unsigned input, not a resolution", () => {
    // The getter body is `return this._delegation.spaceId` (dist/core.js:1273-1275), and
    // `useDelegation` never round-trips to the node (dist/core.js:5056), so the value read back
    // off an activated access is the SAME attacker-rewritable top-level field the bundle
    // supplied. Comparing a derived id against it compares the derived id against the
    // attacker's own input, which is not a control.
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../node_modules/@tinycloud/node-sdk/dist/core.js",
      ),
      "utf-8",
    );
    expect(source).toContain("get spaceId() {\n    return this._delegation.spaceId;");
  });

  it("the V4 verdict artifact is checked in, and it escalates", () => {
    // §2.3 (as amended by §12b defect 6) lists this as a checked-in artifact; S2b's acceptance
    // reads it. It must not be quietly absent, and it must not read as a clean pass.
    const verdict = JSON.parse(readFileSync(`${FIXTURES}/V4_VERDICT.json`, "utf-8")) as {
      result: string;
      verdict: string;
      derivationDeterministic: boolean;
      resolvedSpaceIdReadable: boolean;
    };
    expect(verdict.derivationDeterministic).toBe(true);
    expect(verdict.resolvedSpaceIdReadable).toBe(false);
    expect(verdict.verdict).toBe("ESCALATE");
  });
});
