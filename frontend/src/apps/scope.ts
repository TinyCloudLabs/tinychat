// Scope arithmetic for One Apps grants: resolve ceiling entries to the owner's spaces, clamp requests to the ceiling,
// split a scope into one delegation per space (the SDK's delegateTo takes one space per call).

import type { PermissionEntry } from "@tinycloud/web-sdk";
import type { CeilingEntry, OneAppOwner } from "./registry";
import type { ScopeId } from "./strings";

/** A ceiling entry with its space resolved and its actions in short form ("get", not "tinycloud.kv/get"). */
export interface ResolvedEntry {
  scope: ScopeId;
  permission: PermissionEntry;
}

/** The owner's id for a space name, as the SDK makes it (`makeSpaceId`; One sets no spacePrefix). */
export function ownerSpaceId(owner: OneAppOwner, space: string): string {
  return space.startsWith("tinycloud:") ? space : `tinycloud:pkh:eip155:${owner.chainId}:${owner.address}:${space}`;
}

function shortActions(service: string, actions: readonly string[]): string[] {
  return actions.map((action) => (action.startsWith(`${service}/`) ? action.slice(service.length + 1) : action));
}

function resolvePermission(owner: OneAppOwner, entry: PermissionEntry): PermissionEntry {
  return {
    ...entry,
    ...(entry.space === undefined ? {} : { space: ownerSpaceId(owner, entry.space) }),
    actions: shortActions(entry.service, entry.actions),
  };
}

export function resolveCeiling(owner: OneAppOwner, ceiling: readonly CeilingEntry[]): ResolvedEntry[] {
  return ceiling.map(({ scope, permission }) => ({ scope, permission: resolvePermission(owner, permission) }));
}

/** A ceiling path covers a requested path when equal, or when it is "" or ends in "/" and prefixes it. */
function pathCovers(ceilingPath: string, path: string): boolean {
  return path === ceilingPath || ceilingPath === "" || (ceilingPath.endsWith("/") && path.startsWith(ceilingPath));
}

function covers(ceiling: PermissionEntry, entry: PermissionEntry): boolean {
  return ceiling.service === entry.service
    && ceiling.space === entry.space
    && pathCovers(ceiling.path, entry.path)
    && entry.actions.every((action) => ceiling.actions.includes(action));
}

/**
 * The ceiling entries a child's request asks for, or undefined when any requested entry falls outside the ceiling
 * (One then answers `denied`). Requested entries may name spaces by short name or by id, actions short or long.
 */
export function clampRequest(owner: OneAppOwner, ceiling: readonly ResolvedEntry[], requested: readonly PermissionEntry[]): ResolvedEntry[] | undefined {
  if (requested.length === 0) return undefined;
  const matched = new Set<ResolvedEntry>();
  for (const raw of requested) {
    const entry = resolvePermission(owner, raw);
    const hit = ceiling.find((candidate) => covers(candidate.permission, entry));
    if (!hit) return undefined;
    matched.add(hit);
  }
  return [...matched];
}

/** Groups entries by space, one group per delegateTo. Spaceless entries (encryption) ride with no space: dropped. */
export function bySpace(entries: readonly ResolvedEntry[]): Map<string, PermissionEntry[]> {
  const groups = new Map<string, PermissionEntry[]>();
  for (const { permission } of entries) {
    if (permission.space === undefined) continue;
    const group = groups.get(permission.space) ?? [];
    group.push(permission);
    groups.set(permission.space, group);
  }
  return groups;
}

/** Order-independent identity of a scope, to tell whether a re-grant would hand out the same authority. */
export function scopeKey(entries: readonly ResolvedEntry[]): string {
  return entries
    .map(({ permission }) => JSON.stringify([permission.service, permission.space ?? "", permission.path, [...permission.actions].sort()]))
    .sort()
    .join("\n");
}
