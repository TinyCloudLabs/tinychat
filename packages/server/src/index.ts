// ── Re-export everything ─────────────────────────────────────────────

export {
  KvResultError,
  assertKvResult,
  createBackendIdentity,
  isKvMissingKeyResult,
  withSessionRefresh,
  type BackendIdentityConfig,
  type BackendIdentity,
} from "./identity.js";

export {
  DelegationStore,
  EXO_SYNC_GRANT_KIND,
  TRANSCRIPT_WRITER_GRANT_KIND,
  type DelegationGrantKind,
  type DelegationMetadata,
} from "./delegation-store.js";

export { DelegationCache } from "./delegation-cache.js";

export type { DelegatedAccess } from "@tinycloud/node-sdk";

export {
  createNonceStore,
  verifySIWE,
  verifySiweSession,
  issueSessionToken,
  verifySessionToken,
  type NonceStore,
  type NonceEntry,
  type VerifiedSiweSession,
  type SessionTokenPayload,
} from "./auth.js";

export { createCsrfMiddleware, type CsrfConfig } from "./csrf.js";
