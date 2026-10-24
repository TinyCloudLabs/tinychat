// The sign-in manifest entries that manifest revision "2" stands for. One list, read by the backend test
// that pins the served manifest.json and by the frontend gate that decides whether a served or signed
// manifest really carries them (the web app and the backend image deploy separately).
//
// Paths are relative, as in manifest.json: they resolve under the app id.

export interface RequiredManifestEntry {
  readonly service: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly skipPrefix?: true;
}

export const SIGN_IN_BUNDLE_ENTRIES: readonly RequiredManifestEntry[] = [
  { service: "tinycloud.sql", path: "details", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "summaries", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "transcripts", actions: ["read", "write", "schema"] },
  { service: "tinycloud.kv", path: "migrations/", actions: ["get", "put"] },
  { service: "tinycloud.space", path: "", actions: ["info"], skipPrefix: true },
  { service: "tinycloud.kv", path: "exo/v1/requests/", actions: ["get", "list", "del"] },
  { service: "tinycloud.kv", path: "exo/v1/jobs/", actions: ["get", "put", "del"] },
];

interface ManifestLike {
  readonly permissions?: unknown;
}

/**
 * True when `manifest` declares every bundle entry: same service, path and skipPrefix, and at least the
 * entry's actions. Anything else (no manifest, an older manifest, a narrower entry) is false.
 */
export function manifestCarriesBundle(manifest: ManifestLike | null | undefined): boolean {
  const permissions = manifest?.permissions;
  if (!Array.isArray(permissions)) return false;
  return SIGN_IN_BUNDLE_ENTRIES.every((required) =>
    permissions.some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const candidate = entry as { service?: unknown; path?: unknown; actions?: unknown; skipPrefix?: unknown };
      if (candidate.service !== required.service || candidate.path !== required.path) return false;
      if ((candidate.skipPrefix === true) !== (required.skipPrefix === true)) return false;
      const actions = candidate.actions;
      return Array.isArray(actions) && required.actions.every((action) => actions.includes(action));
    }),
  );
}
