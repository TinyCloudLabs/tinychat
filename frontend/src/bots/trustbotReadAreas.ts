// What Main may read in each area the owner turns on. Matches TRANSCRIPT_PERMISSIONS in lib/agentDelegation.ts.
import type { PermissionEntry } from "@tinycloud/web-sdk";

const TINYCHAT_DATA_SPACE = "applications";

export const READ_AREAS = {
  meetings: [
    { service: "tinycloud.sql", space: TINYCHAT_DATA_SPACE, path: "xyz.tinycloud.tinychat/connectors", actions: ["read"], skipPrefix: true },
    { service: "tinycloud.kv", space: TINYCHAT_DATA_SPACE, path: "xyz.tinycloud.tinychat/connectors/", actions: ["get", "list"], skipPrefix: true },
  ],
} satisfies Record<string, PermissionEntry[]>;

export type ReadArea = keyof typeof READ_AREAS;

/** The permissions of every listed area, each area once. */
export function readAreaPermissions(areas: readonly ReadArea[]): PermissionEntry[] {
  return [...new Set(areas)].flatMap((area) => READ_AREAS[area].map((entry) => ({ ...entry, actions: [...entry.actions] })));
}
