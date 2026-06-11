import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guard the 3 documented vendor URL redirects (ST12b). The vendored verifier is
// byte-identical to upstream EXCEPT for three fetch-URL redirects that route
// CORS-blocked upstream calls through our forge-proof backend passthrough. A
// re-vendor ("copy upstream over this directory") silently reverts them; these
// assertions fail loudly if any redirect was lost. Run
// `node scripts/apply-vendor-redirects.mjs` to re-apply.
const VENDOR = join(import.meta.dir, "vendor/redpill-verifier");
const read = (rel: string) => readFileSync(join(VENDOR, rel), "utf8");

describe("vendor URL redirects intact (ST12b)", () => {
  test("signature → backend passthrough (verify.ts)", () => {
    const src = read("verify.ts");
    // Redirect present.
    expect(src).toContain("${BACKEND_ORIGIN}/api/signature");
    // No direct RedPill signature fetch reverted in.
    expect(src).not.toContain("api.redpill.ai/v1/signature");
    expect(src).not.toContain("${API_BASE}/v1/signature");
  });

  test("Phala TDX + NRAS → backend passthrough (verifiers/cloud-api.ts)", () => {
    const src = read("verifiers/cloud-api.ts");
    // Both redirects present.
    expect(src).toContain("${BACKEND_ORIGIN}/api/phala-verify");
    expect(src).toContain("${BACKEND_ORIGIN}/api/nras-proxy");
    // No direct upstream hosts in this file's (all-redirected) fetch paths.
    expect(src).not.toContain("nras.attestation.nvidia.com");
    expect(src).not.toContain("cloud-api.phala.network");
  });
});
