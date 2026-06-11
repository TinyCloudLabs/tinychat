import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Guard the 3 documented vendor URL redirects (ST12b). The vendored verifier is
// byte-identical to upstream EXCEPT for three fetch-URL redirects that route
// CORS-blocked upstream calls through our forge-proof backend passthrough. A
// re-vendor ("copy upstream over this directory") silently reverts them; these
// assertions fail loudly if any redirect was lost. Run
// `node scripts/apply-vendor-redirects.mjs` to re-apply.
const VENDOR = join(import.meta.dir, "vendor/redpill-verifier");
const read = (rel: string) => readFileSync(join(VENDOR, rel), "utf8");

function vendorFiles(dir = VENDOR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return vendorFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function executableSource(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("vendor URL redirects intact (ST12b)", () => {
  test("signature → backend passthrough (verify.ts)", () => {
    const src = read("verify.ts");
    expect(src).toContain("const BACKEND_ORIGIN =");
    expect(src).toContain("function tinychatBackendHeaders");
    // Redirect present.
    expect(src).toContain("${BACKEND_ORIGIN}/api/signature");
    // No direct RedPill signature fetch reverted in.
    expect(src).not.toContain("api.redpill.ai/v1/signature");
    expect(src).not.toContain("${API_BASE}/v1/signature");
  });

  test("Phala TDX + NRAS → backend passthrough (verifiers/cloud-api.ts)", () => {
    const src = read("verifiers/cloud-api.ts");
    expect(src).toContain("const BACKEND_ORIGIN =");
    expect(src).toContain("function tinychatBackendHeaders");
    // Both redirects present.
    expect(src).toContain("${BACKEND_ORIGIN}/api/phala-verify");
    expect(src).toContain("${BACKEND_ORIGIN}/api/nras-proxy");
    // No direct upstream hosts in this file's (all-redirected) fetch paths.
    expect(src).not.toContain("nras.attestation.nvidia.com");
    expect(src).not.toContain("cloud-api.phala.network");
  });

  test("all vendor fetches either use backend redirects or approved public upstreams", () => {
    const approvedHosts = [
      "api.redpill.ai",
      "cloud-api.phala.network/api/v1/apps/",
      "search.sigstore.dev",
      "api.trustauthority.intel.com",
      "rpc.ata.network",
      "1rpc.io",
      "publicnode.com",
      "etherscan.io",
      "explorer.ata.network",
      "explorer-testnet.ata.network",
      "api-github-proxy.tinfoil.sh",
      "gh-attestation-proxy.tinfoil.sh",
      "localhost:8080",
      "${appId}-8090",
    ];
    const forbiddenDirectFetchHosts = [
      "api.redpill.ai/v1/signature",
      "nras.attestation.nvidia.com",
      "cloud-api.phala.network/api/v1/attestations/verify",
    ];

    for (const file of vendorFiles()) {
      const src = executableSource(readFileSync(file, "utf8"));
      const rel = relative(VENDOR, file);
      for (const host of forbiddenDirectFetchHosts) {
        expect(src.includes(host), `${rel} must not directly fetch ${host}`).toBe(false);
      }
      for (const match of src.matchAll(/https?:\/\/([^`'"\s)]+)/g)) {
        const url = match[0];
        expect(
          approvedHosts.some((host) => url.includes(host)),
          `${rel} contains unapproved upstream URL ${url}`,
        ).toBe(true);
      }
    }
  });
});
