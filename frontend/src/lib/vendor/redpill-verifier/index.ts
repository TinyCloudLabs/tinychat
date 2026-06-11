// Main API
export { verify, verifyModel } from './verify.js'
export type { VerifyOptions, VerifyResult, VerifyModelOptions, VerifyModelResult } from './verify.js'

// Provider detection
export { detectProvider, getPrimaryProvider, detectProviderFromAttestation } from './providers/detect.js'
export type { ProviderType, ModelInfo } from './providers/detect.js'

// Verifiers — cloud API (light mode)
export { checkTdxQuote, checkReportData, checkGpu, checkCompose, checkSigstore } from './verifiers/cloud-api.js'

// Verifiers — dstack (deep mode)
export { isDstackAvailable, verifyWithDstack } from './verifiers/dstack.js'
export type { DstackResult, DstackVerifierOptions } from './verifiers/dstack.js'

// Verifiers — provider-specific
export { verifyTinfoil, parseTdxQuote, parseSevSnpReport, detectQuoteType, checkHardwarePolicy, checkManifestPolicy } from './verifiers/tinfoil.js'
export type { TinfoilResult, TdxRegisters } from './verifiers/tinfoil.js'
export { verifyChutes } from './verifiers/chutes.js'
export type { ChutesResult, ChutesEvidence } from './verifiers/chutes.js'

// Verifiers — Intel Trust Authority
export { verifyWithIta } from './verifiers/intel-ita.js'
export type { ItaResult } from './verifiers/intel-ita.js'

// Verifiers — on-chain
export { verifyOnchain, storeProof, lookupProof } from './verifiers/onchain.js'

// Utilities
export { sha256, randomNonce, decodeJwtPayload, selectAttestation } from './utils.js'

// Constants
export { API_BASE, AUTOMATA_NETWORKS, DCAP_VERIFY_ABI, PROOF_STORE_ABI, DEFAULT_MODEL } from './constants.js'

// Types
export type {
  AttestationReport,
  RawAttestation,
  TdxQuote,
  TdxQuoteBody,
  TdxResult,
  ReportDataResult,
  GpuResult,
  ComposeResult,
  SigstoreLink,
  SignaturePayload,
  AttestationResult,
  SignatureResult,
  OnchainVerifyResult,
  ProofRecord,
  StoreProofResult,
  NetworkConfig,
  NetworkKey,
} from './types.js'
