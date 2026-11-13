import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { IKVService } from "@tinycloud/sdk-services";
import { z } from "zod";
import { loadProfile } from "../agent-sync/fireflies";
import { homeMirrorRefusal } from "./bridge";
import type { HomeMirrorContext } from "./bridge-types";

export const fullSpace = z.string().regex(/^tinycloud:[^\s]+:[^\s]+$/);

export function normalizeHomeMirrorHost(value: string): string {
  const host = new URL(value);
  if (!["http:", "https:"].includes(host.protocol) || host.username || host.password || host.search || host.hash) throw homeMirrorRefusal("Invalid node host");
  return host.href.replace(/\/+$/, "");
}

export interface OwnerSessionOptions {
  tcHome: string;
  profile: string;
  ownerSpace: string;
  legacySpace: string;
  host?: string;
  signal: AbortSignal;
}

export interface OwnerSession {
  ctx: HomeMirrorContext;
  node: TinyCloudNode;
  /** The legacy board space with delete, for the synthetic check's cleanup only. */
  legacyKv: Pick<IKVService, "get" | "put" | "delete">;
}

// Existing owner session only: no sign-in, delegation activation, key generation,
// schema initialization, legacy CLI invocation, or profile/host mutation.
export async function openOwnerSession(options: OwnerSessionOptions): Promise<OwnerSession> {
  const ownerSpaceId = fullSpace.parse(options.ownerSpace), legacySpaceId = fullSpace.parse(options.legacySpace);
  const profile = loadProfile(options.tcHome, options.profile);
  if (profile.spaceId !== ownerSpaceId || (profile.expiresAt !== null && (!Number.isFinite(Date.parse(profile.expiresAt)) || Date.parse(profile.expiresAt) <= Date.now()))) throw homeMirrorRefusal("Existing owner session is unavailable");
  const host = normalizeHomeMirrorHost(options.host ?? profile.host);
  const node = new TinyCloudNode({ host, includeAccountRegistryPermissions: false });
  await node.restoreSession({ ...profile.session, tinycloudHosts: [host] });
  const legacyKv = node.kvForSpace(legacySpaceId);
  const ctx: HomeMirrorContext = { ownerSpaceId, sql: node.sqlForSpace(ownerSpaceId), legacySpaceId, legacy: legacyKv, now: () => new Date().toISOString(), signal: options.signal };
  return { ctx, node, legacyKv };
}

/** Aborts on SIGINT/SIGTERM while `work` runs. */
export async function withStopSignal<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try { return await work(controller.signal); }
  finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
