#!/usr/bin/env node
/**
 * Re-apply the 3 documented vendor URL redirects (ST12b).
 *
 * The vendored RedPill verifier
 * (frontend/src/lib/vendor/redpill-verifier/**) is byte-identical to upstream
 * EXCEPT for three fetch-URL redirects that route CORS-blocked upstream calls
 * through our forge-proof backend passthrough:
 *
 *   1. signature  → `${BACKEND_ORIGIN}/api/signature/...`   (verify.ts)
 *   2. Phala TDX  → `${BACKEND_ORIGIN}/api/phala-verify`    (verifiers/cloud-api.ts)
 *   3. NRAS       → `${BACKEND_ORIGIN}/api/nras-proxy`      (verifiers/cloud-api.ts)
 *
 * VENDOR.md's update procedure is "copy upstream over this directory", which
 * silently reverts these on the next bump. This script re-applies the URL
 * redirects IDEMPOTENTLY (a no-op when already applied) so a re-vendor can be
 * followed by `node scripts/apply-vendor-redirects.mjs`. The matching guard test
 * (frontend/src/lib/vendorRedirects.test.ts) fails loudly if a redirect is lost.
 *
 * NOTE: this script applies the fetch-URL redirects only. The supporting
 * `BACKEND_ORIGIN` constant + `tinychatBackendHeaders` helper additions are
 * documented in VENDOR.md; if a re-vendor drops those, this script reports that
 * the scaffold is missing and exits non-zero.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "frontend/src/lib/vendor/redpill-verifier");

/** Each rule: a direct-upstream fetch form → its backend-proxy replacement. */
const RULES = [
  {
    file: "verify.ts",
    marker: "${BACKEND_ORIGIN}/api/signature",
    replacements: [
      // signature GET reverted to a direct RedPill call.
      [/https:\/\/api\.redpill\.ai\/v1\/signature/g, "${BACKEND_ORIGIN}/api/signature"],
      [/\$\{API_BASE\}\/v1\/signature/g, "${BACKEND_ORIGIN}/api/signature"],
    ],
  },
  {
    file: "verifiers/cloud-api.ts",
    marker: "${BACKEND_ORIGIN}/api/phala-verify",
    replacements: [
      [/fetch\(\s*PHALA_TDX_VERIFIER_URL/g, "fetch(`${BACKEND_ORIGIN}/api/phala-verify`"],
      [
        /https:\/\/cloud-api\.phala\.network\/api\/v1\/attestations\/verify/g,
        "${BACKEND_ORIGIN}/api/phala-verify",
      ],
      [/fetch\(\s*NVIDIA_NRAS_URL/g, "fetch(`${BACKEND_ORIGIN}/api/nras-proxy`"],
      [
        /https:\/\/nras\.attestation\.nvidia\.com\/v3\/attest\/gpu/g,
        "${BACKEND_ORIGIN}/api/nras-proxy",
      ],
    ],
  },
];

let changed = false;
let scaffoldMissing = false;

for (const rule of RULES) {
  const path = join(VENDOR, rule.file);
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    console.error(`✗ vendor file not found: ${rule.file}`);
    process.exit(1);
  }
  let next = src;
  for (const [from, to] of rule.replacements) next = next.replace(from, to);
  if (next !== src) {
    writeFileSync(path, next);
    changed = true;
    console.log(`✔ re-applied redirect(s) in ${rule.file}`);
  }
  if (!next.includes("BACKEND_ORIGIN")) {
    scaffoldMissing = true;
    console.error(
      `✗ ${rule.file}: BACKEND_ORIGIN scaffold missing — re-add the const + ` +
        `tinychatBackendHeaders helper per VENDOR.md before the redirects can work.`,
    );
  }
}

if (scaffoldMissing) process.exit(1);
console.log(changed ? "Vendor redirects re-applied." : "Vendor redirects already in place — nothing to do.");
