import type { RenewalVerifyConfig } from "../renewal-verify.js";
import { areaResources, isReadArea, type ReadArea, type ReadResource } from "./areas.js";
import type { ReadAccess } from "./grants.js";
import { confirmedStandingReadRevocation, standingReadAuthority, type StandingReadGrant, type StandingReadHolder, type VerifyRenewalChain } from "./standing-grant.js";

export interface CollectedStandingRead {
  grant: StandingReadGrant;
  holder: StandingReadHolder;
  activate(resources: readonly ReadResource[], validUntil: number): Promise<ReadAccess>;
}

export type StandingReadView = {
  areas: ReadArea[];
  active: { originalCid: string; areas: readonly ReadArea[]; validUntil: number | null } | null;
  pending: { approveUrl: string } | null;
  previousOriginalCid: string | null;
  outcome: "declined" | "expired" | "failed" | null;
};

export interface StandingReadControl {
  view(owner: string, areas: ReadArea[]): Promise<StandingReadView>;
  request(owner: string, areas: ReadArea[]): Promise<StandingReadView>;
  /** Compare the owner's current/previous CID and confirm its revocation at the node before dropping it. */
  finishStop(owner: string, originalCid: string): Promise<void>;
  /** Refuse if the area is still in a standing grant. Cancel pending approval for the old area selection. */
  beforeAreaOff(owner: string, area: ReadArea): Promise<void>;
}

export interface StandingReadStore {
  current(owner: string): Promise<CollectedStandingRead | undefined>;
  /** Compare against the original CID so a stale read cannot drop a new approval. */
  drop(owner: string, originalCid: string): Promise<void>;
}

type StandingReadResult = { state: "active"; access: ReadAccess } | { state: "absent" | "ended" | "unavailable" };
export class StandingReadOwnerMismatch extends Error {}

export type StandingReadPolicyRefusal = "no_grant" | "not_owner" | "expired" | "revoked" | "unavailable";

/** Checks standing authority for each read. */
export class StandingReadRuntime {
  constructor(private readonly deps: {
    store: StandingReadStore;
    config: RenewalVerifyConfig;
    fetch?: typeof fetch;
    now?: () => number;
    verifyRenewalChain?: VerifyRenewalChain;
  }) {}

  /** The caller obtains owner from the verified internal call. A finite fallback has its own outcome. */
  async access(
    owner: string,
    area: ReadArea,
    path?: string,
    onPolicyRefusal?: (outcome: StandingReadPolicyRefusal) => void,
  ): Promise<StandingReadResult> {
    const { store, config, fetch, now, verifyRenewalChain } = this.deps;
    try {
      const record = await store.current(owner);
      if (!record || !isReadArea(area) || !record.grant.areas.includes(area)) {
        onPolicyRefusal?.("no_grant");
        return { state: "absent" };
      }
      const { grant, holder } = record;
      const resources = areaResources([area]).filter(resource => path === undefined || path === resource.path);
      if (resources.length === 0) {
        onPolicyRefusal?.("no_grant");
        return { state: "unavailable" };
      }
      const authority = await standingReadAuthority(grant, { address: owner, holder, config, fetch, now, verifyRenewalChain });
      if (authority.state !== "active") {
        if (authority.state === "ended") await store.drop(owner, grant.originalCid);
        onPolicyRefusal?.(authority.outcome ?? "unavailable");
        return { state: authority.state };
      }
      const at = (now?.() ?? Date.now() / 1000) * 1000;
      if (at >= authority.validUntil) {
        onPolicyRefusal?.("expired");
        return { state: "ended" };
      }
      // Standing activations are one-use; an activation crossing the checked end is discarded.
      const access = await record.activate(resources, authority.validUntil);
      if ((now?.() ?? Date.now() / 1000) * 1000 >= authority.validUntil) {
        onPolicyRefusal?.("expired");
        return { state: "ended" };
      }
      return { state: "active", access };
    } catch (error) {
      onPolicyRefusal?.(error instanceof StandingReadOwnerMismatch ? "not_owner" : "unavailable");
      return { state: "unavailable" };
    }
  }
}

/** Complete an owner-revoked grant, including a previous grant kept for replace-then-revoke. */
export async function finishStandingReadStop(owner: string, originalCid: string, deps: {
  find(owner: string, originalCid: string): Promise<CollectedStandingRead | undefined>;
  drop(owner: string, originalCid: string): Promise<void>;
  config: RenewalVerifyConfig;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<void> {
  const record = await deps.find(owner, originalCid);
  if (!record) return;
  const { grant, holder } = record;
  if (grant.originalCid !== originalCid || !await confirmedStandingReadRevocation(grant, { ...deps, address: owner, holder })) {
    throw new Error("standing_read_stop_not_confirmed");
  }
  await deps.drop(owner, originalCid);
}
