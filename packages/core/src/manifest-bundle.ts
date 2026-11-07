// The sign-in manifest entries that manifest revision "4" stands for. One list, read by the backend test
// that pins the served manifest.json and by the frontend gate that decides whether a served or signed
// manifest really carries them (the web app and the backend image deploy separately).
//
// Paths are relative, as in manifest.json: they resolve under the app id.

export interface RequiredManifestEntry {
  readonly service: string;
  readonly path: string;
  readonly space?: string;
  readonly actions: readonly string[];
  readonly skipPrefix?: true;
  /** What the sign-in screen says the entry is for. Not compared by manifestCarriesBundle. */
  readonly description?: string;
}

export const SIGN_IN_BUNDLE_ENTRIES: readonly RequiredManifestEntry[] = [
  { service: "tinycloud.sql", path: "details", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "summaries", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "transcripts", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "home_feed", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "feed/", actions: ["read", "write", "schema"] },
  { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/feed/", actions: ["subscribe"], skipPrefix: true },
  { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/home_feed", actions: ["subscribe"], skipPrefix: true },
  { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/threads", actions: ["subscribe"], skipPrefix: true },
  { service: "tinycloud.kv", space: "applications", path: "", actions: ["get", "put", "del", "list", "metadata"], skipPrefix: true },
  { service: "tinycloud.space", path: "", actions: ["info"], skipPrefix: true },
  { service: "tinycloud.kv", path: "exo/v1/requests/", actions: ["get", "list", "del"] },
  { service: "tinycloud.kv", path: "exo/v1/jobs/", actions: ["get", "put", "del"] },
  { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.sample.healthlog/healthlog", actions: ["read", "write", "schema"], skipPrefix: true },
  { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.sample.recipes/recipes", actions: ["read", "write", "schema"], skipPrefix: true },
];

// The entries the Home site's own manifest (manifest.home.json) stands for under its own revision ("home-1").
// The Home site asks for less than the plain build, so it does not carry SIGN_IN_BUNDLE_ENTRIES.
export const HOME_SIGN_IN_BUNDLE_ENTRIES: readonly RequiredManifestEntry[] = [
  { service: "tinycloud.kv", path: "threads/", actions: ["get", "put", "del", "list"] },
  { service: "tinycloud.sql", path: "threads", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "home_feed", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "feed/", actions: ["read", "write", "schema"] },
  { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/feed/", actions: ["subscribe"], skipPrefix: true },
  { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/home_feed", actions: ["subscribe"], skipPrefix: true },
  { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/threads", actions: ["subscribe"], skipPrefix: true },
  { service: "tinycloud.space", path: "", actions: ["info"], skipPrefix: true },
];

/** A Home feature that asks for its own rights when the owner first opens it. */
export type HomeFeature = "recording" | "connectors";

// Recording and Connectors on the Home site. Each set is asked for on top of HOME_SIGN_IN_BUNDLE_ENTRIES when the owner
// opens the feature; the decrypt grant both need is composed at request time, because it names the owner's DID.
// Secrets use the resolved shape of manifest.json's secrets block (the owner's secrets space, vault/secrets/<NAME>),
// with its descriptions. Neither set has the applications-root storage manifest.json carries.
const HOME_MEETING_STORAGE_ENTRIES: readonly RequiredManifestEntry[] = [
  { service: "tinycloud.sql", path: "connectors", actions: ["read", "write", "schema"], description: "Store meeting metadata synced from connected sources (e.g. Fireflies) in your space's SQL database." },
  { service: "tinycloud.kv", path: "connectors/", actions: ["get", "put", "del", "list"], description: "Store transcript content synced from connected sources in your space." },
];

export const HOME_RECORDING_ENTRIES: readonly RequiredManifestEntry[] = [
  ...HOME_MEETING_STORAGE_ENTRIES,
  { service: "tinycloud.sql", path: "details", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "summaries", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "transcripts", actions: ["read", "write", "schema"] },
  // The one key Recording uses outside connectors/: the hosted transcription claim (frontend hostedVoiceNotes.ts).
  { service: "tinycloud.kv", space: "applications", path: "exo/voiceNotes/hostedJobs/", actions: ["get", "put"], skipPrefix: true },
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ASSEMBLYAI_API_KEY", actions: ["get", "put", "del"], skipPrefix: true, description: "Store your AssemblyAI API key, encrypted, in your secrets space." },
];

export const HOME_CONNECTORS_ENTRIES: readonly RequiredManifestEntry[] = [
  ...HOME_MEETING_STORAGE_ENTRIES,
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/FIREFLIES_API_KEY", actions: ["get", "put", "del"], skipPrefix: true, description: "Store your Fireflies API key, encrypted, in your secrets space." },
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/GRANOLA_API_KEY", actions: ["get", "put", "del"], skipPrefix: true, description: "Store your Granola API key, encrypted, in your secrets space." },
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/scoped/google-meet/REFRESH_TOKEN", actions: ["get", "put", "del"], skipPrefix: true, description: "Store your Google sign-in for Google Meet, encrypted, in your secrets space." },
];

export const HOME_FEATURE_ENTRIES: Readonly<Record<HomeFeature, readonly RequiredManifestEntry[]>> = {
  recording: HOME_RECORDING_ENTRIES,
  connectors: HOME_CONNECTORS_ENTRIES,
};

interface ManifestLike {
  readonly permissions?: unknown;
}

/**
 * True when `manifest` declares every bundle entry (the plain build's, unless `entries` names another):
 * same service, space, path and skipPrefix, and at least the entry's actions. Omitted space resolves to `applications`.
 */
export function manifestCarriesBundle(
  manifest: ManifestLike | null | undefined,
  entries: readonly RequiredManifestEntry[] = SIGN_IN_BUNDLE_ENTRIES,
): boolean {
  const permissions = manifest?.permissions;
  if (!Array.isArray(permissions)) return false;
  return entries.every((required) =>
    permissions.some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const candidate = entry as { service?: unknown; space?: unknown; path?: unknown; actions?: unknown; skipPrefix?: unknown };
      if (candidate.service !== required.service || candidate.path !== required.path) return false;
      if ((candidate.space ?? "applications") !== (required.space ?? "applications")) return false;
      if ((candidate.skipPrefix === true) !== (required.skipPrefix === true)) return false;
      const actions = candidate.actions;
      return Array.isArray(actions) && required.actions.every((action) => actions.includes(action));
    }),
  );
}
