// Reviewer seed CLI. Authority comes only from a delegation the space owner grants to this
// run's session key; the key is generated in memory, never written or printed, and is gone
// when the process exits. README.md is the contract.
//
//   bun frontend/scripts/reviewer-seed/cli.ts --space <space id> --owner <did:pkh> \
//     --allow-owner <did:pkh> --request-out <file> (--dry-run | --confirm <space id>)
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { TinyCloudNode, type DelegatedAccess } from "@tinycloud/node-sdk";
import { assertGrant, parseGrant, parseSeedArgs, UsageError } from "./args";
import { assertSeedTarget, readBackSeed, ReviewerSeedRefusal, runReviewerSeed, seedPermissions, type SeedSpace } from "./seed";

/** Home addresses KV by full in-space key; a delegated KV handle prefixes the grant's first path unless told otherwise. */
function rootKv(kv: DelegatedAccess["kv"]): SeedSpace["kv"] {
  return {
    get: (key: string, options?: object) => kv.get(key, { ...options, prefix: "" }),
    put: (key: string, value: unknown, options?: object) => kv.put(key, value, { ...options, prefix: "" }),
  } as unknown as SeedSpace["kv"];
}

async function main(argv: string[]): Promise<void> {
  const options = parseSeedArgs(argv);
  // Refuse a wrong owner, space or confirmation before the owner is asked for anything.
  assertSeedTarget({ did: options.target.ownerDid, spaceId: options.target.spaceId }, options.target, options.mode);
  const node = new TinyCloudNode({ host: options.host, autoCreateSpace: false });
  if (!node.isSessionOnly) throw new Error("The seed must run without an owner key");
  const sessionDid = node.did.split("#")[0]!;
  const request = {
    kind: "tinycloud.auth.request", version: 1, requestId: `reviewer-seed-${randomUUID()}`, createdAt: new Date().toISOString(),
    sessionDid, requested: seedPermissions(options.mode), requestedExpiry: "1h",
  };
  writeFileSync(options.requestOut, `${JSON.stringify(request, null, 2)}\n`);
  process.stderr.write([
    `Seed session key (this run only): ${sessionDid}`,
    `Capability request (${options.mode.dryRun ? "read-only, dry run" : "read and write"}) written to ${options.requestOut}.`,
    `Have the owner ${options.target.ownerDid} grant it, e.g. tinycloud --profile <owner profile> auth grant ${options.requestOut} > grant.json,`,
    "then paste the grant JSON here and end with Ctrl-D (or pipe it in).",
    "",
  ].join("\n"));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const delegation = parseGrant(Buffer.concat(chunks).toString("utf8"), request.requestId);
  assertGrant(delegation, options, sessionDid);
  const access = await node.useDelegation(delegation);
  const space = { did: options.target.ownerDid, spaceId: access.spaceId, sql: access.sql, kv: rootKv(access.kv) } as unknown as SeedSpace;
  const report = await runReviewerSeed(space, options.target, options.mode);
  const readBack = options.mode.dryRun ? undefined : await readBackSeed(space);
  process.stdout.write(`${JSON.stringify({ ...report, ...(readBack ? { readBack } : {}) }, null, 2)}\n`);
}

main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
  // Only the message: SDK errors may carry request objects.
  const usage = error instanceof UsageError;
  const refusal = error instanceof ReviewerSeedRefusal;
  process.stderr.write(`${usage ? "usage" : refusal ? `refused (${error.code})` : "failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(usage ? 2 : refusal ? 3 : 1);
});
