#!/usr/bin/env node
// Fails when a build artifact directory holds anything a public host or package must not ship: sourcemaps,
// a file type outside the allow-list, or a string shaped like a live credential (Stripe live keys, PEM key
// material, 32-byte hex private keys, Slack/GitHub/npm/AWS tokens, JWTs). Generalised from rocinante-sitrep
// scripts/audit-public.mjs. Run `gitleaks dir <dir>` as well; this is the fast, explainable first pass.
//
//   node scripts/release/audit-artifact.mjs --config <policy.json> <dir>
//
// The policy (e.g. .github/security/web-dist-audit.json) lists the allowed extensions and extensionless file
// names, and the reviewed known-public matches (library constants and the like). A reviewed match is named by
// the sha256 of the exact matched text, never the text itself, so the policy file never carries a value, and
// any other value of the same shape still fails. Output never prints a matched value either.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

export const RULES = [
  { id: "stripe-live", re: /\b[sr]k_live_[A-Za-z0-9]{10,}/g },
  // The header plus up to 64 base64 characters after it: a parser's bare header constant hashes the same in
  // every build and can be reviewed once; an embedded key's body changes the match.
  { id: "pem-block", re: /-----BEGIN[A-Z0-9 ]*-----(?:[\s"'+]|\\n)*[A-Za-z0-9+/=]{0,64}/g },
  { id: "hex-32-bytes", re: /(?<![0-9A-Za-z])0x[0-9a-fA-F]{64}(?![0-9A-Za-z])/g },
  { id: "slack-token", re: /\bxox[bp]-[A-Za-z0-9-]{10,}/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g },
  { id: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github-token", re: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

export const sha256 = (text) => createHash("sha256").update(text, "latin1").digest("hex");

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    // Symlinks and other non-regular entries are reported as problems by the caller.
    else files.push(path);
  }
  return files;
}

// Returns { problems, reviewedCounts, files, unused }; never includes matched text.
export function auditArtifact(root, policy) {
  const allowedExt = new Set(policy.allowedExtensions);
  const allowedNames = new Set(policy.allowedExtensionlessNames ?? []);
  const reviewed = new Map((policy.reviewedMatches ?? []).map((m) => [`${m.rule}:${m.sha256}`, m]));
  const reviewedCounts = new Map();
  const problems = [];
  const files = walk(root).sort();
  for (const file of files) {
    const name = relative(root, file).split("\\").join("/");
    const ext = extname(name).toLowerCase();
    if (!lstatSync(file).isFile()) {
      problems.push(`${name}: not a regular file`);
      continue;
    }
    if (ext === ".map") problems.push(`${name}: sourcemap file`);
    else if (ext ? !allowedExt.has(ext) : !allowedNames.has(basename(name))) {
      problems.push(`${name}: file type not on the allow-list`);
    }
    // latin1 keeps every byte, so binary files are scanned too.
    const text = readFileSync(file).toString("latin1");
    if (/[#@]\s*sourceMappingURL=/.test(text)) problems.push(`${name}: sourceMappingURL`);
    for (const { id, re } of RULES) {
      for (const match of text.matchAll(re)) {
        const key = `${id}:${sha256(match[0])}`;
        if (reviewed.has(key)) {
          reviewedCounts.set(key, (reviewedCounts.get(key) ?? 0) + 1);
        } else {
          problems.push(`${name}: ${id} match sha256 ${key.slice(id.length + 1)}`);
        }
      }
    }
  }
  return { problems, reviewedCounts, files, unused: [...reviewed.keys()].filter((key) => !reviewedCounts.has(key)) };
}

function main(argv) {
  const configIndex = argv.indexOf("--config");
  const config = configIndex === -1 ? undefined : argv[configIndex + 1];
  const root = argv.filter((_, i) => i !== configIndex && i !== configIndex + 1)[0];
  if (!config || !root) {
    console.error("usage: audit-artifact.mjs --config <policy.json> <dir>");
    return 2;
  }
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`audit-artifact: ${root} is not a directory; build it first`);
    return 1;
  }
  const policy = JSON.parse(readFileSync(config, "utf8"));
  const { problems, reviewedCounts, files, unused } = auditArtifact(root, policy);
  if (files.length === 0) problems.push("artifact is empty");
  console.log(`audit-artifact: scanned ${files.length} files in ${root}`);
  const reasons = new Map((policy.reviewedMatches ?? []).map((m) => [`${m.rule}:${m.sha256}`, m.reason]));
  for (const [key, count] of reviewedCounts) {
    console.log(`audit-artifact: reviewed ${key.slice(0, key.indexOf(":") + 13)} x${count}: ${reasons.get(key)}`);
  }
  for (const key of unused) console.log(`audit-artifact: reviewed match ${key} no longer occurs; drop it from ${config}`);
  if (problems.length > 0) {
    console.error(`audit-artifact: FAILED with ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "A credential-shaped match fails the deploy. If it is a reviewed public value (a library constant, a public " +
        `id), add {rule, sha256, reason} to reviewedMatches in ${config}; anything that may be live goes to security first.`,
    );
    return 1;
  }
  console.log("audit-artifact: passed");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
