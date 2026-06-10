import type { Hex, Address } from 'viem'

// ---------------------------------------------------------------------------
// API Response Types
// ---------------------------------------------------------------------------

export interface AttestationReport {
  signing_address?: string
  signing_algo?: string
  request_nonce?: string
  intel_quote?: string
  nvidia_payload?: string
  info?: { tcb_info?: string | TcbInfo }
  quote?: unknown
  event_log?: unknown
  vm_config?: unknown
  signing_public_key?: string
  // Multi-node formats
  all_attestations?: RawAttestation[]
  gateway_attestation?: RawAttestation
  model_attestations?: (RawAttestation & { model_name?: string })[]
  error?: unknown
}

export interface RawAttestation {
  signing_address: string
  signing_algo?: string
  request_nonce?: string
  intel_quote: string
  nvidia_payload?: string
  info?: { tcb_info?: string | TcbInfo }
  [key: string]: unknown
}

export interface TcbInfo {
  app_compose?: string
  [key: string]: unknown
}

export interface TdxQuoteBody {
  reportdata: string
  mrconfig: string
  mrtd?: string
  [key: string]: unknown
}

export interface TdxQuote {
  verified?: boolean
  message?: string
  body?: TdxQuoteBody
  [key: string]: unknown
}

export interface TdxVerifyResponse {
  quote?: TdxQuote
  message?: string
}

export interface SignaturePayload {
  text: string
  signature: string
  signing_address: string
  signing_algo?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Result Types (returned by library functions)
// ---------------------------------------------------------------------------

export interface TdxResult {
  verified: boolean
  message?: string
  quote?: TdxQuote
}

export interface ReportDataResult {
  bindsAddress: boolean
  embedsNonce: boolean
  signingAlgo: string
}

export interface GpuResult {
  nonceMatches: boolean
  verdict: string
}

export interface ComposeResult {
  hashMatches: boolean
  composeHash: string
  mrConfig: string
  manifest?: string
}

export interface SigstoreLink {
  url: string
  accessible: boolean
  status: number
}

export interface AttestationResult {
  signingAddress: string
  nonce: string
  tdx: TdxResult
  reportData: ReportDataResult | null
  gpu: GpuResult | null
  compose: ComposeResult | null
  sigstore: SigstoreLink[]
  onchain: OnchainVerifyResult | null
}

export interface SignatureResult {
  chatId: string
  requestHashMatch: boolean
  responseHashMatch: boolean
  signatureValid: boolean
  recoveredAddress: string
  signingAddress: string
  attestation: AttestationResult | null
}

export interface OnchainVerifyResult {
  verified: boolean
  quoteHash: string
  network: string
  contract: string
  explorer: string
}

export interface ProofRecord {
  quoteHash: Hex
  signingAddress: Address
  isValid: boolean
  timestamp: bigint
  blockNumber: bigint
  submitter: Address
}

export interface StoreProofResult {
  txHash: Hex
  quoteHash: Hex
  isValid: boolean
  blockNumber: bigint
  gasUsed: bigint
  explorer: string
}

// ---------------------------------------------------------------------------
// Config Types
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  name: string
  chainId: number
  rpc: string
  contract: Address
  explorer: string
}

export type NetworkKey = 'automata-mainnet' | 'automata-testnet' | 'sepolia' | 'holesky'

export interface VerifyAttestationOptions {
  model?: string
  network?: NetworkKey
  skipOnchain?: boolean
}

export interface VerifySignatureOptions {
  model?: string
  apiKey: string
  message?: string
  network?: NetworkKey
  skipOnchain?: boolean
  skipAttestation?: boolean
}

/** Verify an EXISTING chat response by its chatId. */
export interface VerifyResponseOptions {
  /** The chat completion ID (response.id from the OpenAI-compatible API) */
  chatId: string
  /** Model name used for the chat */
  model: string
  /** RedPill API key */
  apiKey: string
  /** Original request body JSON string (optional, for hash comparison) */
  requestBody?: string
  /** Original raw response text (optional, for hash comparison) */
  responseText?: string
  /** Automata network for on-chain verification */
  network?: NetworkKey
  /** Skip on-chain DCAP verification */
  skipOnchain?: boolean
  /** Skip TEE attestation verification */
  skipAttestation?: boolean
}

export interface VerifyOnchainOptions {
  model?: string
  network?: NetworkKey
}

export interface StoreProofOptions {
  model?: string
  network?: NetworkKey
  proofStore: Address
  privateKey: Hex
}

export interface LookupProofOptions {
  quoteHash: Hex
  proofStore: Address
  network?: NetworkKey
}
