// The reviewer seed CLI's inputs: the command line and the owner's grant, both checked
// before the seed touches storage. README.md is the contract.
import { parseArgs } from "node:util";
import { deserializeDelegation, type PortableDelegation } from "@tinycloud/node-sdk";
import { ReviewerSeedRefusal, seedPermissions, type ReviewerSeedMode, type ReviewerSeedTarget } from "./seed";

export const DEFAULT_HOST = "https://tee.node.tinycloud.xyz";
/** The longest grant the seed accepts; a run needs minutes and asks for one hour. */
const MAX_GRANT_MS = 24 * 60 * 60_000;

export interface SeedCliOptions { target: ReviewerSeedTarget; mode: ReviewerSeedMode; host: string; requestOut: string }

export class UsageError extends Error {}

/** Parses and checks the command line. Everything here is decided before any network request. */
export function parseSeedArgs(argv: string[]): SeedCliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: {
        space: { type: "string" }, owner: { type: "string" }, "allow-owner": { type: "string", multiple: true },
        "request-out": { type: "string" }, host: { type: "string" }, "dry-run": { type: "boolean" }, confirm: { type: "string" },
      },
    }));
  } catch (error) { throw new UsageError((error as Error).message); }
  const missing = (["space", "owner", "allow-owner", "request-out"] as const).filter((name) => !values[name]?.length);
  if (missing.length) throw new UsageError(`Missing ${missing.map((name) => `--${name}`).join(", ")}`);
  if (values["dry-run"] && values.confirm !== undefined) throw new UsageError("--dry-run writes nothing; drop --confirm");
  if (!values["dry-run"] && values.confirm === undefined) throw new UsageError("Pass --dry-run, or --confirm <the target space id> to write");
  const host = values.host ?? DEFAULT_HOST;
  if (!/^https:\/\/[^/]+$/.test(host)) throw new UsageError("--host must be an https origin");
  return {
    target: { spaceId: values.space!, ownerDid: values.owner!, allowlist: values["allow-owner"]! },
    mode: values["dry-run"] ? { dryRun: true } : { dryRun: false, confirm: values.confirm },
    host, requestOut: values["request-out"]!,
  };
}

/** Reads the owner's grant: a `tinycloud.auth.delegation` artifact (from `tinycloud auth grant`) or a bare portable delegation. */
export function parseGrant(raw: string, requestId: string): PortableDelegation {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ReviewerSeedRefusal("TARGET_MISMATCH", "The grant is not JSON"); }
  if (!parsed || typeof parsed !== "object") throw new ReviewerSeedRefusal("TARGET_MISMATCH", "The grant is not a delegation");
  if ("kind" in parsed && parsed.kind === "tinycloud.auth.delegation") {
    if (!("requestId" in parsed) || parsed.requestId !== requestId) throw new ReviewerSeedRefusal("TARGET_MISMATCH", "The grant answers a different request");
    return deserializeDelegation(JSON.stringify("delegation" in parsed ? parsed.delegation : null));
  }
  return deserializeDelegation(raw);
}

/**
 * The grant must be addressed to this run's key, issued by the target owner for the target
 * space on this host, live, short, and (where it lists its resources) no wider than asked.
 */
export function assertGrant(delegation: PortableDelegation, options: SeedCliOptions, sessionDid: string, now = Date.now()): void {
  const refuse = (message: string) => { throw new ReviewerSeedRefusal("TARGET_MISMATCH", message); };
  if (delegation?.delegateDID?.split("#")[0] !== sessionDid) refuse("The grant is not addressed to this run's session key");
  if (delegation.spaceId !== options.target.spaceId) refuse("The grant is for a different space");
  if (`did:pkh:eip155:${delegation.chainId}:${delegation.ownerAddress}`.toLowerCase() !== options.target.ownerDid.toLowerCase())
    refuse("The grant was not issued by the target owner");
  if (delegation.host !== undefined && delegation.host.replace(/\/$/, "") !== options.host) refuse("The grant names a different node");
  const expiry = delegation.expiry instanceof Date ? delegation.expiry.getTime() : Number.NaN;
  if (!(expiry > now)) refuse("The grant has expired or has no expiry");
  if (expiry - now > MAX_GRANT_MS) refuse("The grant lasts longer than 24 hours; grant the request's 1 hour");
  const requested = seedPermissions(options.mode);
  for (const resource of delegation.resources ?? []) {
    const service = resource.service.startsWith("tinycloud.") ? resource.service : `tinycloud.${resource.service}`;
    if (resource.space !== options.target.spaceId) refuse(`The grant covers another space (${resource.space})`);
    if (service === "tinycloud.capabilities" && resource.actions.every((action) => action === "tinycloud.capabilities/read")) continue;
    const asked = requested.find((entry) => entry.service === service && entry.path === resource.path);
    if (!asked || resource.actions.some((action) => !asked.actions.includes(action)))
      refuse(`The grant is wider than the request (${service} ${resource.path || "/"} ${resource.actions.join(",")})`);
  }
}
