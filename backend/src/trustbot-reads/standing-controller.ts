import { randomUUID } from "node:crypto";
import type { OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import type { RenewalVerifyConfig } from "../renewal-verify.js";
import type { ReadArea } from "./areas.js";
import { standingDelegatedAccess } from "./standing-access.js";
import { StandingApprovalClient, standingTargetPublicJwk, type StandingApprovalLink } from "./standing-approval.js";
import {
  standingReadAuthority, standingReadPermissions, STANDING_READ_LEASE_SECONDS, STANDING_READ_WINDOW_SECONDS,
  verifyStandingReadApproval, type StandingReadGrant,
} from "./standing-grant.js";
import { finishStandingReadStop, StandingReadOwnerMismatch, type CollectedStandingRead, type StandingReadControl, type StandingReadView } from "./standing.js";
import type { HolderScope, StandingApprovalKeys } from "./standing-holder.js";
import type { OwnerDid, StandingHolder } from "./standing-types.js";

/** How often the background sweep re-checks an active grant. Reads never reuse a sweep's answer. */
const SWEEP_CHECK_MS = 5 * 60_000;

interface Approval {
  scope: HolderScope;
  link: StandingApprovalLink;
}

interface PendingApproval extends Approval {
  areas: ReadArea[];
}

interface ActiveApproval extends Approval {
  grant: StandingReadGrant;
}

export interface StandingReadMetadata {
  generation: number;
  pending?: PendingApproval;
  active?: ActiveApproval;
  previous?: ActiveApproval;
  outcome?: "declined" | "expired" | "failed";
}

export interface StandingMetadataStore {
  read(owner: OwnerDid): Promise<{ state: StandingReadMetadata; version?: string }>;
  write(owner: OwnerDid, state: StandingReadMetadata, version: string | undefined): Promise<boolean>;
  owners(): AsyncIterable<OwnerDid>;
}

const addr = (owner: OwnerDid) => owner.slice("did:pkh:eip155:1:".length);
function ownerDid(address: string): OwnerDid {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("standing_read_owner_invalid");
  return `did:pkh:eip155:1:${address.toLowerCase()}`;
}

function sameAreas(left: readonly ReadArea[], right: readonly ReadArea[]) {
  return left.length === right.length && left.every(area => right.includes(area));
}

/** Approval-specific state contains no holder, relay or link key. Every update compares a durable store version. */
type StandingApprovalPort = Pick<StandingApprovalClient, "create" | "url" | "collect" | "acknowledge" | "leaseState">;

export class StandingReadsController implements StandingReadControl {
  readonly #openKey: StandingApprovalPort;
  readonly #swept = new Map<string, number>();
  readonly #collecting = new Map<OwnerDid, Promise<void>>();
  #sweeping = false;

  constructor(private readonly deps: {
    store: StandingMetadataStore;
    keys: StandingApprovalKeys;
    config: RenewalVerifyConfig;
    enabledAreas(address: string): Promise<ReadArea[]>;
    openKey?: StandingApprovalPort;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.#openKey = deps.openKey ?? new StandingApprovalClient({ keys: deps.keys });
  }

  async view(address: string, areas: ReadArea[]): Promise<StandingReadView> {
    const owner = ownerDid(address);
    await this.#refresh(owner, areas);
    let { state } = await this.deps.store.read(owner);
    let validUntil = state.active ? await this.#activeEnd(owner, state.active) : null;
    const latest = (await this.deps.store.read(owner)).state;
    if (state.active?.grant.originalCid !== latest.active?.grant.originalCid) validUntil = null;
    state = latest;
    const { active, pending, previous, outcome } = state;
    return {
      areas,
      active: active ? { originalCid: active.grant.originalCid, areas: active.grant.areas, validUntil } : null,
      pending: pending ? { approveUrl: await this.#openKey.url(pending.scope, pending.link) } : null,
      previousOriginalCid: previous?.grant.originalCid ?? null,
      outcome: outcome ?? null,
    };
  }

  async request(address: string, areas: ReadArea[]): Promise<StandingReadView> {
    const owner = ownerDid(address);
    if (!areas.length) throw new Error("standing_read_areas_missing");
    await this.#refresh(owner, areas);
    const { state, version } = await this.deps.store.read(owner);
    if (state.previous || (state.pending && sameAreas(state.pending.areas, areas)) ||
        (state.active && sameAreas(state.active.grant.areas, areas))) return this.view(address, areas);
    const scope = { owner, approvalId: randomUUID(), generation: state.generation + 1 };
    const holder = await this.#holder(scope);
    const request = await this.#request(scope, holder, areas);
    const link = await this.#openKey.create(scope, holder, request);
    if (!await this.deps.store.write(owner, {
      ...state, generation: scope.generation, pending: { scope, link, areas }, outcome: undefined,
    }, version)) throw new Error("standing_reads_changed");
    return this.view(address, areas);
  }

  async finishStop(address: string, originalCid: string): Promise<void> {
    await finishStandingReadStop(address, originalCid, {
      config: this.deps.config, fetch: this.deps.fetch, now: () => this.#seconds(),
      find: async (address, cid) => {
        const owner = ownerDid(address);
        const { state } = await this.deps.store.read(owner);
        const approval = [state.active, state.previous].find(entry => entry?.grant.originalCid === cid);
        return approval && this.#record(owner, approval);
      },
      drop: (address, cid) => this.drop(address, cid),
    });
  }

  async beforeAreaOff(address: string, area: ReadArea): Promise<void> {
    const owner = ownerDid(address);
    const { state, version } = await this.deps.store.read(owner);
    if (state.active?.grant.areas.includes(area) || state.previous?.grant.areas.includes(area)) {
      throw new Error("standing_read_revoke_required");
    }
    if (!state.pending?.areas.includes(area)) return;
    if (!await this.deps.store.write(owner, {
      ...state, generation: state.generation + 1, pending: undefined,
    }, version)) throw new Error("standing_reads_changed");
  }

  async current(address: string): Promise<CollectedStandingRead | undefined> {
    const owner = ownerDid(address);
    const { state } = await this.deps.store.read(owner);
    return state.active && this.#record(owner, state.active);
  }

  async drop(address: string, originalCid: string): Promise<void> {
    const owner = ownerDid(address);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state, version } = await this.deps.store.read(owner);
      const active = state.active?.grant.originalCid === originalCid;
      const previous = state.previous?.grant.originalCid === originalCid;
      if (!active && !previous) return;
      const next = active
        ? { ...state, generation: state.generation + 1, active: undefined, pending: undefined }
        : { ...state, generation: state.generation + 1, previous: undefined };
      if (await this.deps.store.write(owner, next, version)) {
        this.#swept.delete(originalCid);
        return;
      }
    }
    throw new Error("standing_reads_changed");
  }

  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      for await (const owner of this.deps.store.owners()) {
        try {
          const { state } = await this.deps.store.read(owner);
          if (state.pending) await this.#refresh(owner, await this.deps.enabledAreas(addr(owner)));
          if (state.active) {
            const cid = state.active.grant.originalCid;
            const last = this.#swept.get(cid);
            if (last === undefined || this.#now() - last >= SWEEP_CHECK_MS) {
              this.#swept.set(cid, this.#now());
              await this.#activeEnd(owner, state.active);
            }
          }
          if (state.previous && state.previous.grant.leaseEnd <= this.#seconds()) await this.drop(addr(owner), state.previous.grant.originalCid);
        } catch { /* A failed owner is retried independently on the next pass. */ }
      }
    } finally {
      this.#sweeping = false;
    }
  }

  #now() { return this.deps.now?.() ?? Date.now(); }
  #seconds() { return Math.floor(this.#now() / 1000); }

  #holder(scope: HolderScope) {
    return this.deps.keys.derive(scope.owner, scope.approvalId, scope.generation);
  }

  async #request(scope: HolderScope, holder: StandingHolder, areas: ReadArea[]): Promise<OpenKeyApprovalRequestV1> {
    return {
      issuer: holder.did, requestVersion: 1, targetDid: holder.did, targetPublicJwk: standingTargetPublicJwk(holder),
      nodeOrigin: this.deps.config.nodeOrigin, permissions: standingReadPermissions(areas), purpose: "standing",
      reason: "Keep the bot’s selected reads on while you’re away.",
      grantLifetimeSeconds: STANDING_READ_WINDOW_SECONDS,
      renewal: { version: 1, leaseLifetimeSeconds: STANDING_READ_LEASE_SECONDS },
      resultEncryptionPublicJwk: await this.deps.keys.relayPublicKey(scope),
    };
  }

  #refresh(owner: OwnerDid, areas: ReadArea[]): Promise<void> {
    const running = this.#collecting.get(owner);
    if (running) return running;
    const job = this.#collect(owner, areas).finally(() => this.#collecting.delete(owner));
    this.#collecting.set(owner, job);
    return job;
  }

  async #collect(owner: OwnerDid, areas: ReadArea[]): Promise<void> {
    const { state, version } = await this.deps.store.read(owner);
    const { pending } = state;
    if (!pending || state.previous) return;
    if (!sameAreas(pending.areas, areas)) {
      await this.deps.store.write(owner, { ...state, generation: state.generation + 1, pending: undefined }, version);
      return;
    }
    if (pending.scope.owner !== owner) throw new Error("standing_read_owner_invalid");
    const holder = await this.#holder(pending.scope);
    const result = await this.#openKey.collect(pending.scope, holder, pending.link);
    if (result.state === "pending") return;
    if (result.state !== "ready") {
      await this.deps.store.write(owner, { ...state, pending: undefined, outcome: result.state }, version);
      return;
    }
    let grant: StandingReadGrant;
    try {
      grant = await verifyStandingReadApproval({
        opened: result.opened, requestId: pending.link.requestId, bodyCid: pending.link.bodyCid,
        request: await this.#request(pending.scope, holder, pending.areas), address: addr(owner), areas: pending.areas,
        config: this.deps.config, now: this.#seconds(),
      });
    } catch {
      await this.deps.store.write(owner, { ...state, pending: undefined, outcome: "failed" }, version);
      return;
    }
    const active = { scope: pending.scope, link: pending.link, grant };
    const currentAreas = await this.deps.enabledAreas(addr(owner));
    if (!sameAreas(currentAreas, pending.areas)) {
      await this.deps.store.write(owner, { ...state, generation: state.generation + 1, pending: undefined }, version);
      return;
    }
    const next = { ...state, active, previous: state.active, pending: undefined, outcome: undefined };
    if (await this.deps.store.write(owner, next, version)) {
      await this.#openKey.acknowledge(holder, pending.link, result.resultRef, pending.scope.approvalId).catch(() => {});
    }
  }

  async #activeEnd(owner: OwnerDid, approval: ActiveApproval): Promise<number | null> {
    const { grant, holder } = await this.#record(owner, approval);
    const authority = await standingReadAuthority(grant, {
      address: addr(owner), config: this.deps.config, holder, fetch: this.deps.fetch, now: () => this.#seconds(),
    });
    if (authority.state === "ended") await this.drop(addr(owner), grant.originalCid);
    return authority.state === "active" ? authority.validUntil : null;
  }

  async #record(owner: OwnerDid, { scope, link, grant }: ActiveApproval): Promise<CollectedStandingRead> {
    if (scope.owner !== owner || grant.ownerDid !== owner) throw new StandingReadOwnerMismatch("standing_read_owner_invalid");
    const standing = await this.#holder(scope);
    if (standing.did !== grant.holderDid) throw new Error("standing_read_holder_changed");
    return {
      grant,
      holder: {
        did: standing.did,
        signStatus: standing.sign,
        leaseState: () => this.#openKey.leaseState(standing, link, grant.originalCid, grant.leaseEnd),
      },
      activate: async (resources, validUntil) => standingDelegatedAccess({
        config: this.deps.config, grant, holder: standing, resources, validUntil, fetch: this.deps.fetch, now: () => this.#now(),
        assertCurrent: async () => {
          const { state } = await this.deps.store.read(owner);
          if (state.active?.grant.originalCid !== grant.originalCid ||
              state.active.scope.generation !== scope.generation) throw new Error("standing_reads_changed");
        },
      }),
    };
  }
}
