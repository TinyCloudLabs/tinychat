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
  /**
   * The TinyCloud Private Transcription (ptx-batch) origin that voice notes (Exo mobile) and Upload
   * audio (every platform) upload to, e.g. `https://<app_id>-8080.<gateway>`. Unset = neither offers
   * private transcription, whatever the backend says; the backend never supplies an upload origin.
   */
  readonly VITE_EXO_PTX_UPLOAD_ORIGIN?: string;
  /**
   * Exo mobile health spike (TC-525): "true" shows the development-only Health card in Connectors → Sources
   * (when the app's native Health plugin exists, i.e. Android and iOS debug builds). Unset in every normal build.
   */
  readonly VITE_EXO_HEALTH_SPIKE?: string;
  /**
   * "true" shows the TC-524 location spike's dev card (Connectors → Sources) in the Exo app. Leave unset: it is a
   * prototype, and only debug builds of the app have the location permissions it needs.
   */
  readonly VITE_EXO_LOCATION_SPIKE?: string;
  /** "true" registers the PWA service worker under `vite dev` too (src/lib/pwa.ts); off by default. */
  readonly VITE_PWA_DEV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
