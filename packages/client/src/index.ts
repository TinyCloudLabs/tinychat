// ── Re-export everything ─────────────────────────────────────────────

export {
  connectWallet,
  openKeyRenewalClient,
  type ConnectWalletConfig,
  type ConnectWalletResult,
  type EIP1193Provider,
  type OpenKeyRenewalAsk,
  type OpenKeyRenewalOutcome,
} from "./openkey.js";

export {
  createTinyCloudWeb,
  createAndSignIn,
  restoreTinyCloudWebSession,
  type RestoreTinyCloudWebSessionResult,
  type TinyCloudWebConfig,
} from "./tinycloud.js";

export {
  loadAppManifest,
  backendManifestFromServerInfo,
  composeManifestWithBackend,
  composeManifestWithDelegatees,
  resolveManifestPermissions,
  resolveManifestDelegationPermissions,
  resolveManifestPermissionPath,
} from "./manifest.js";

export {
  loadPersistedSession,
  clearPersistedSession,
  saveRenewalReceipt,
  loadRenewalReceipt,
  type PersistedTinyCloudSession,
} from "./session-persistence.js";

export {
  createDelegation,
  createManifestDelegation,
  sendDelegation,
  checkDelegationStatus,
  revokeDelegation,
} from "./delegation.js";

export {
  requestNonce,
  verifySession,
  verifyRenewedSession,
  renewalVerifyProof,
  type VerifyResponse,
  type RenewalVerifyProof,
  type VerifyRenewedSessionBody,
  type VerifyRenewedSessionResponse,
} from "./auth.js";

export { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE } from "./request-headers.js";

export { SessionStore, type StoredSession } from "./tokens.js";

export { createApiClient, type ApiClient, type ApiClientConfig } from "./api.js";
