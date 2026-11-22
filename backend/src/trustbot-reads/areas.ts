// The owner's data TrustBot may read, by area. Each area is a fixed list of resources in the owner's applications
// space, read actions only; the owner turns each area on separately and one grant covers the areas that are on.
// frontend/src/bots/trustbotReadAreas.ts asks for the same resources when the owner signs.
// Details: TC-3792
import { APP_ID } from "@tinyboilerplate/core";

export interface ReadResource {
  service: "sql" | "kv";
  path: string;
  actions: readonly string[];
}

/** The only abilities an area may name. A write, delete or decrypt ability is never one of them. */
export const READ_ACTIONS = ["tinycloud.sql/read", "tinycloud.kv/get", "tinycloud.kv/list"] as const;

export const READ_AREAS = {
  // The meeting tools (mcp-meetings/reader.ts) read connector_meeting rows and transcript bodies under connectors/.
  meetings: [
    { service: "sql", path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read"] },
    { service: "kv", path: `${APP_ID}/connectors/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
  ],
} as const satisfies Record<string, readonly ReadResource[]>;

export type ReadArea = keyof typeof READ_AREAS;
export const READ_AREA_NAMES = Object.keys(READ_AREAS) as ReadArea[];

export function isReadArea(value: unknown): value is ReadArea {
  return typeof value === "string" && Object.hasOwn(READ_AREAS, value);
}

/** The resources a grant for `areas` must name exactly: each path once, with the union of its areas' actions. */
export function areaResources(areas: readonly ReadArea[]): ReadResource[] {
  const merged = new Map<string, { service: ReadResource["service"]; path: string; actions: Set<string> }>();
  for (const area of new Set(areas)) {
    for (const resource of READ_AREAS[area] as readonly ReadResource[]) {
      const key = `${resource.service}/${resource.path}`;
      const entry = merged.get(key) ?? { service: resource.service, path: resource.path, actions: new Set<string>() };
      for (const action of resource.actions) entry.actions.add(action);
      merged.set(key, entry);
    }
  }
  return [...merged.values()].map(({ service, path, actions }) => ({ service, path, actions: [...actions].sort() }));
}
