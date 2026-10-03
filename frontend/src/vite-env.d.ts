/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Opt-in local real-data validation; DEV and loopback page/backend only. */
  readonly VITE_LOCAL_VALIDATION?: string;
  readonly VITE_OPENKEY_HOST?: string;
  readonly VITE_BACKEND_URL?: string;
  readonly VITE_TINYCLOUD_HOST?: string;
  /** Agent DID override for a local joint-stack smoke; production uses the frozen default. */
  readonly VITE_AGENT_DID?: string;
  /** Browser-e2e lane only — retargets the Fireflies client at the mock upstream. */
  readonly VITE_FIREFLIES_API_URL?: string;
  /** Browser-e2e lane only — collapses the client's inter-request pacing. */
  readonly VITE_FIREFLIES_DELAY_MS?: string;
  /**
   * "true" lets the Exo native app run Google OAuth in the system browser (TC-521). Leave unset
   * until the return is a claimed https link; the backend's GOOGLE_OAUTH_NATIVE_RETURN must match.
   */
  readonly VITE_EXO_NATIVE_GOOGLE_OAUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
