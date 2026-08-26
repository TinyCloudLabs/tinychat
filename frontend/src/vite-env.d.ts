/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENKEY_HOST?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_TINYCLOUD_HOST?: string;
  /** Agent DID override for a local joint-stack smoke; production uses the frozen default. */
  readonly VITE_AGENT_DID?: string;
  /** Browser-e2e lane only — retargets the Fireflies client at the mock upstream. */
  readonly VITE_FIREFLIES_API_URL?: string;
  /** Browser-e2e lane only — collapses the client's inter-request pacing. */
  readonly VITE_FIREFLIES_DELAY_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
