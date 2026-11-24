import { randomBytes } from "node:crypto";
import { DelegatedAccess } from "@tinycloud/node-sdk";
import { signCompactUcanAuthorization } from "@tinycloud/sdk-core";
import { isCanonicalResourcePath } from "@tinycloud/share-envelope";
import type { RenewalVerifyConfig } from "../renewal-verify.js";
import type { ReadResource } from "./areas.js";
import type { StandingReadGrant } from "./standing-grant.js";
import type { StandingHolder } from "./standing-types.js";

const CALL_HEADER = "x-tinychat-standing-invoke";
const CALL_MS = 10_000;

/** Give the SDK its normal SQL/KV response handling while the actual authorization uses the TEE signing handle. */
export function standingDelegatedAccess(input: {
  config: RenewalVerifyConfig;
  grant: StandingReadGrant;
  holder: StandingHolder;
  resources: readonly ReadResource[];
  validUntil: number;
  assertCurrent: () => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}): DelegatedAccess {
  const { config, grant, holder, resources, validUntil, assertCurrent } = input;
  const now = input.now ?? Date.now;
  const resource = resources[0];
  if (!resource || holder.did !== grant.holderDid) throw new Error("standing_read_scope_invalid");
  const target = `${config.nodeOrigin}/invoke`;
  const ownerAddress = grant.ownerDid.slice("did:pkh:eip155:1:".length);
  const delegationHeader = { Authorization: "" };
  const snapshot = {
    cid: grant.originalCid, spaceId: grant.spaceId, ownerAddress, chainId: 1,
    delegateDID: holder.did, path: resource.path, actions: [...resource.actions], expiry: new Date(validUntil),
    resources: resources.map(entry => ({ ...entry, space: grant.spaceId, actions: [...entry.actions] })),
    delegationHeader, host: config.nodeOrigin,
  };
  return new DelegatedAccess({
    address: ownerAddress, chainId: 1, sessionKey: "", spaceId: grant.spaceId,
    delegationCid: grant.originalCid, delegationHeader, verificationMethod: holder.did, jwk: {},
    siwe: "", signature: "",
  }, snapshot, config.nodeOrigin,
  (_session, service, path, action) => ({ [CALL_HEADER]: JSON.stringify([service, path, action]) }),
  undefined, undefined, {
    track: context => context,
    async fetch(url, init) {
      // The marker is consumed locally. Only this pinned node and these checked, canonical reads can get signed.
      const headers = new Headers(init?.headers);
      const call = headers.get(CALL_HEADER);
      headers.delete(CALL_HEADER);
      if (String(url) !== target || init?.method !== "POST" || call === null) throw new Error("standing_read_invocation_invalid");
      const [service, path, action] = JSON.parse(call) as [string, string, string];
      const checkPath = path.endsWith("/") ? path.slice(0, -1) : path;
      if (!isCanonicalResourcePath(checkPath) || !resources.some(entry =>
        entry.service === service && entry.actions.includes(action) &&
          (path === entry.path || (entry.path.endsWith("/") && path.startsWith(entry.path))))) {
        throw new Error("standing_read_scope_invalid");
      }
      await assertCurrent();
      const sentAt = Math.floor(now() / 1000);
      const expiresAt = Math.min(sentAt + 60, Math.floor(validUntil / 1000));
      if (expiresAt <= sentAt) throw new Error("standing_read_ended");
      const authorization = await signCompactUcanAuthorization({
        issuerDid: holder.did, audienceDid: config.nodeDid,
        attenuation: { [`${grant.spaceId}/${service}/${path}`]: { [action]: [{}] } },
        notBefore: sentAt, expiresAt, nonce: randomBytes(16).toString("hex"),
        facts: [{}], proofs: [grant.originalCid], sign: bytes => holder.sign(bytes),
      });
      if (now() >= validUntil) throw new Error("standing_read_ended");
      headers.set("Authorization", authorization.authorization);
      const remaining = Math.max(1, Math.min(CALL_MS, validUntil - now()));
      const timeout = AbortSignal.timeout(Math.ceil(remaining));
      return (input.fetch ?? fetch)(target, { ...init, headers, redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    },
  });
}
