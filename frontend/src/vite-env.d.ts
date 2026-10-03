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
   * Exo mobile: the TinyCloud Private Transcription (ptx-batch) origin voice notes are uploaded to,
   * e.g. `https://<app_id>-8080.<gateway>`. Unset (every build today) = voice-note transcription is
   * never offered, whatever the backend says; the backend never supplies an upload origin.
   */
  readonly VITE_EXO_PTX_UPLOAD_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
