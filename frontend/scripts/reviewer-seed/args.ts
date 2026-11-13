// The reviewer seed CLI's inputs: the command line and the owner's grant, both checked
// before the seed touches storage. README.md is the contract.
import { parseArgs } from "node:util";
import { deserializeDelegation, type PortableDelegation } from "@tinycloud/node-sdk";
import { ReviewerSeedRefusal, seedPermissions, type ReviewerSeedMode, type ReviewerSeedTarget } from "./seed";

export const DEFAULT_HOST = "https://node.tinycloud.xyz";
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
  let url: URL | null = null;
  try { url = new URL(host); } catch { /* not a URL */ }
  if (url?.protocol !== "https:" || url.origin !== host) throw new UsageError("--host must be an https origin, such as https://node.tinycloud.xyz");
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
 * The authority a compact UCAN grant signs: its audience, expiry and capabilities, read from
 * the signed payload rather than the transport fields beside it. The signature and the
 * delegation chain back to the owner are verified by the node when the grant is used.
 * Anything that is not a compact UCAN is refused.
 */
export function signedGrant(authorization: string): { audience: string; expiry: number; capabilities: { resource: string; actions: string[] }[] } {
  const refuse = (message: string): never => { throw new ReviewerSeedRefusal("TARGET_MISMATCH", message); };
  const parts = authorization.replace(/^Bearer /i, "").split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) refuse("The grant is not a compact UCAN");
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")); } catch { refuse("The grant's signed payload is unreadable"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return refuse("The grant's signed payload is unreadable");
  const aud = "aud" in payload ? payload.aud : undefined;
  const exp = "exp" in payload ? payload.exp : undefined;
  const att = "att" in payload ? payload.att : undefined;
  if (typeof aud !== "string" || typeof exp !== "number" || !Number.isFinite(exp)) return refuse("The grant's signed payload has no audience or expiry");
  if (!att || typeof att !== "object" || Array.isArray(att)) return refuse("The grant's signed payload has no capabilities");
  const capabilities = Object.entries(att).map(([resource, abilities]) => {
    if (!abilities || typeof abilities !== "object" || Array.isArray(abilities)) return refuse(`The grant signs a malformed capability (${resource})`);
    return { resource, actions: Object.keys(abilities) };
  });
  if (!capabilities.length || capabilities.some((capability) => !capability.actions.length)) refuse("The grant signs no capabilities");
  return { audience: aud, expiry: exp * 1000, capabilities };
}

/**
 * The grant must be addressed to this run's key, issued by the target owner for the target
 * space on this host, live, at most 24 hours, and no wider than asked. Both its transport
 * fields and its signed payload (`signedGrant`) are checked here, before use, and its `cid`
 * must be the CID of those signed bytes (`cidOf`, the SDK's `computeDelegationCid`): the node
 * enforces the delegation the CID names. The node then verifies the signature and the chain
 * to the owner.
 */
export function assertGrant(delegation: PortableDelegation, options: SeedCliOptions, sessionDid: string,
  cidOf: (authorization: string) => string, now = Date.now()): void {
  const refuse = (message: string) => { throw new ReviewerSeedRefusal("TARGET_MISMATCH", message); };
  if (delegation?.delegateDID?.split("#")[0] !== sessionDid) refuse("The grant is not addressed to this run's session key");
  if (delegation.spaceId !== options.target.spaceId) refuse("The grant is for a different space");
  if (`did:pkh:eip155:${delegation.chainId}:${delegation.ownerAddress}`.toLowerCase() !== options.target.ownerDid.toLowerCase())
    refuse("The grant was not issued by the target owner");
  if (delegation.host !== undefined && delegation.host.replace(/\/$/, "") !== options.host) refuse("The grant names a different node");
  const expiry = delegation.expiry instanceof Date ? delegation.expiry.getTime() : Number.NaN;
  const assertLifetime = (end: number) => {
    if (!(end > now)) refuse("The grant has expired or has no expiry");
    if (end - now > MAX_GRANT_MS) refuse("The grant lasts longer than 24 hours; grant the request's 1 hour");
  };
  assertLifetime(expiry);
  if (!Array.isArray(delegation.resources) || delegation.resources.length === 0) refuse("The grant does not list its resources");
  const requested = seedPermissions(options.mode);
  const assertAsked = (rawService: string, path: string, actions: string[]) => {
    const service = rawService.startsWith("tinycloud.") ? rawService : `tinycloud.${rawService}`;
    if (service === "tinycloud.capabilities" && actions.every((action) => action === "tinycloud.capabilities/read")) return;
    const asked = requested.find((entry) => entry.service === service && entry.path === path);
    if (!asked || actions.some((action) => !asked.actions.includes(action)))
      refuse(`The grant is wider than the request (${service} ${path || "/"} ${actions.join(",")})`);
  };
  for (const resource of delegation.resources ?? []) {
    if (resource.space !== options.target.spaceId) refuse(`The grant covers another space (${resource.space})`);
    assertAsked(resource.service, resource.path, resource.actions);
  }
  for (const action of delegation.actions ?? []) assertAsked(action.split("/")[0]!, delegation.path, [action]);

  // The signed payload: what the node will actually enforce, under the CID that names it.
  const authorization = delegation.delegationHeader?.Authorization ?? "";
  const signed = signedGrant(authorization);
  if (cidOf(authorization) !== delegation.cid) refuse("The grant's CID does not match its signed bytes");
  if (signed.audience.split("#")[0] !== sessionDid) refuse("The grant's signed audience is not this run's session key");
  assertLifetime(signed.expiry);
  for (const { resource, actions } of signed.capabilities) {
    const match = /^(tinycloud:[^/]+)\/([a-z]+)\/(.*)$/.exec(resource);
    if (!match) return refuse(`The grant signs an unexpected resource (${resource})`);
    const [, space, service, path] = match;
    if (space !== options.target.spaceId) refuse(`The grant signs another space (${space})`);
    assertAsked(service!, path!, actions);
  }
}
