/**
 * Top-level verification API.
 *
 * verify(chatId)       — verify an existing chat response (the one-liner)
 * verifyAttestation()  — verify TEE attestation for a model
 * verifyModel()        — auto-detect provider and verify with all checks
 */

import { recoverMessageAddress, type Address, type Hex } from 'viem'
import { API_BASE, DEFAULT_MODEL } from './constants.js'
import { detectProvider, detectProviderFromAttestation, getPrimaryProvider, type ProviderType } from './providers/detect.js'
import { checkTdxQuote, checkReportData, checkGpu, checkCompose, checkSigstore } from './verifiers/cloud-api.js'
import { isDstackAvailable, verifyWithDstack, type DstackResult } from './verifiers/dstack.js'
import { verifyOnchain } from './verifiers/onchain.js'
import { verifyTinfoil, type TinfoilResult } from './verifiers/tinfoil.js'
import { verifyChutes, type ChutesResult, type ChutesEvidence } from './verifiers/chutes.js'
import { verifyWithIta, type ItaResult } from './verifiers/intel-ita.js'
import { randomNonce, selectAttestation, sha256 } from './utils.js'
import type {
  AttestationReport,
  AttestationResult,
  NetworkKey,
  RawAttestation,
  SignaturePayload,
  SignatureResult,
  OnchainVerifyResult,
  GpuResult,
  ComposeResult,
} from './types.js'
// ── TinyChat deviation (see VENDOR.md) ─────────────────────────────────────
// The browser has no RedPill API key, so the key-bearing signature call is
// routed through our forge-proof backend passthrough. BACKEND_ORIGIN and the
// auth/CSRF headers reuse the same storage/header contract as frontend/src/lib/chatApi.ts.

const BACKEND_ORIGIN =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? 'http:'}//localhost:3014`
const SESSION_STORAGE_KEY = 'xyz.tinycloud.tinychat:session'
const DEFAULT_REQUEST_HEADER_NAME = 'X-Requested-With'
const DEFAULT_REQUEST_HEADER_VALUE = 'XMLHttpRequest'

function tinychatSessionToken(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown }
    if (typeof parsed.expiresAt === 'number' && Date.now() >= parsed.expiresAt - 30_000) return null
    return typeof parsed.token === 'string' ? parsed.token : null
  } catch {
    return null
  }
}

function tinychatBackendHeaders(includeCsrf: boolean): Record<string, string> {
  const token = tinychatSessionToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (includeCsrf) headers[DEFAULT_REQUEST_HEADER_NAME] = DEFAULT_REQUEST_HEADER_VALUE
  return headers
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchAttestation(model: string, nonce: string): Promise<AttestationReport> {
  const url = `${API_BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}`
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  return res.json()
}

async function fetchSignature(chatId: string, model: string, apiKey: string): Promise<SignaturePayload> {
  // TinyChat deviation (see VENDOR.md): route through the backend signature
  // passthrough, which injects REDPILL_API_KEY server-side. `apiKey` is unused
  // here (the proxy ignores it); the param stays for signature compatibility.
  void apiKey
  const url = `${BACKEND_ORIGIN}/api/signature/${chatId}?model=${encodeURIComponent(model)}`
  const res = await fetch(url, {
    headers: tinychatBackendHeaders(false),
    signal: AbortSignal.timeout(30_000),
  })
  return res.json()
}

/**
 * Fetch system info from Phala Cloud for deep verification.
 */
async function fetchPhalaSystemInfo(appId: string): Promise<Record<string, unknown>> {
  const url = `https://cloud-api.phala.network/api/v1/apps/${appId}/attestations`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  return res.json()
}

/**
 * Fetch vm_config from the app's PRPC endpoint (needed for deep verification).
 */
async function fetchAppVmConfig(appId: string, kmsUrl: string): Promise<{ vmConfig: string | null; appCompose: string | null }> {
  try {
    const parsed = new URL(kmsUrl)
    const parts = parsed.hostname.split('.')
    const domain = parts.slice(-3).join('.')
    const rpcUrl = `https://${appId}-8090.${domain}/prpc/Info`

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { vmConfig: null, appCompose: null }

    const info = await res.json() as Record<string, unknown>
    const tcbInfoStr = info.tcb_info as string | undefined
    let appCompose: string | null = null
    if (tcbInfoStr) {
      const tcb = JSON.parse(tcbInfoStr) as Record<string, unknown>
      appCompose = tcb.app_compose as string | null
    }
    return { vmConfig: info.vm_config as string | null, appCompose }
  } catch {
    return { vmConfig: null, appCompose: null }
  }
}

// ---------------------------------------------------------------------------
// Deep verification (dstack-verifier Docker)
// ---------------------------------------------------------------------------

interface DeepComponentResult {
  name: string
  result: DstackResult
}

async function deepVerifyPhala(
  appId: string,
  dstackUrl?: string,
): Promise<{ components: DeepComponentResult[]; allValid: boolean }> {
  const sysInfo = await fetchPhalaSystemInfo(appId)
  const instances = (sysInfo.instances ?? []) as Array<Record<string, unknown>>
  if (!instances.length) throw new Error('No instances found for app')

  const instance = instances[0]
  const kmsUrl = ((sysInfo.kms_info ?? {}) as Record<string, string>).url ?? ''

  // Fetch model's own vm_config via PRPC
  const { vmConfig: modelVmConfig, appCompose } = await fetchAppVmConfig(appId, kmsUrl)

  const components: DeepComponentResult[] = []

  // Model component
  const instTcb = (instance.tcb_info ?? {}) as Record<string, unknown>
  const modelQuote = instance.quote as string
  const modelEventLog = instTcb.event_log
  if (modelQuote && modelEventLog && modelVmConfig) {
    const r = await verifyWithDstack(
      modelQuote,
      typeof modelEventLog === 'string' ? modelEventLog : JSON.stringify(modelEventLog),
      modelVmConfig,
      { serviceUrl: dstackUrl },
    )
    components.push({ name: 'model', result: r })
  }

  // KMS component
  const kms = (sysInfo.kms_guest_agent_info ?? {}) as Record<string, unknown>
  const kmsTcb = (kms.tcb_info ?? {}) as Record<string, unknown>
  const kmsCerts = (kms.app_certificates ?? [{}]) as Array<Record<string, string>>
  const kmsQuote = kmsCerts[0]?.quote
  const kmsEventLog = kmsTcb.event_log
  const kmsVmConfig = kms.vm_config as string | undefined
  if (kmsQuote && kmsEventLog && kmsVmConfig) {
    const r = await verifyWithDstack(
      kmsQuote,
      typeof kmsEventLog === 'string' ? kmsEventLog : JSON.stringify(kmsEventLog),
      kmsVmConfig,
      { serviceUrl: dstackUrl },
    )
    components.push({ name: 'kms', result: r })
  }

  // Gateway component
  const gw = (sysInfo.gateway_guest_agent_info ?? {}) as Record<string, unknown>
  const gwTcb = (gw.tcb_info ?? {}) as Record<string, unknown>
  const gwCerts = (gw.app_certificates ?? [{}]) as Array<Record<string, string>>
  const gwQuote = gwCerts[0]?.quote
  const gwEventLog = gwTcb.event_log
  const gwVmConfig = gw.vm_config as string | undefined
  if (gwQuote && gwEventLog && gwVmConfig) {
    const r = await verifyWithDstack(
      gwQuote,
      typeof gwEventLog === 'string' ? gwEventLog : JSON.stringify(gwEventLog),
      gwVmConfig,
      { serviceUrl: dstackUrl },
    )
    components.push({ name: 'gateway', result: r })
  }

  const allValid = components.length > 0 && components.every((c) => c.result.isValid)
  return { components, allValid }
}

async function deepVerifyNearAI(
  attestation: RawAttestation,
  gatewayAttestation: RawAttestation | null,
  dstackUrl?: string,
): Promise<{ components: DeepComponentResult[]; allValid: boolean }> {
  const components: DeepComponentResult[] = []

  for (const [name, att] of [['model', attestation], ['gateway', gatewayAttestation]] as const) {
    if (!att) continue
    const el = att.event_log as unknown
    const info = (att.info ?? {}) as Record<string, unknown>
    const vm = info.vm_config as string | undefined
    if (att.intel_quote && el && vm) {
      const r = await verifyWithDstack(
        att.intel_quote,
        typeof el === 'string' ? el : JSON.stringify(el),
        vm,
        { serviceUrl: dstackUrl },
      )
      components.push({ name, result: r })
    }
  }

  const allValid = components.length > 0 && components.every((c) => c.result.isValid)
  return { components, allValid }
}

// ---------------------------------------------------------------------------
// verifyModel — the main orchestrator
// ---------------------------------------------------------------------------

export interface VerifyModelOptions {
  model?: string
  /** Force deep verification via dstack-verifier Docker (default: auto-detect) */
  deep?: boolean
  /** URL of dstack-verifier service */
  dstackUrl?: string
  /** Automata network for on-chain verification */
  network?: NetworkKey
  /** Skip on-chain DCAP verification */
  skipOnchain?: boolean
  /** Skip Sigstore provenance check */
  skipSigstore?: boolean
  /** Intel Trust Authority API key (optional) */
  itaApiKey?: string
}

export interface VerifyModelResult {
  verified: boolean
  model: string
  provider: ProviderType
  hardware: string[]
  signingAddress: string | null
  nonce: string
  /** Light mode results (cloud APIs) */
  light: {
    tdx: AttestationResult['tdx'] | null
    reportData: AttestationResult['reportData']
    gpu: GpuResult | null
    compose: ComposeResult | null
    sigstore: AttestationResult['sigstore']
  }
  /** Deep mode results (dstack-verifier Docker) */
  deep: {
    available: boolean
    components: DeepComponentResult[]
    allValid: boolean
  } | null
  /** On-chain DCAP verification */
  onchain: OnchainVerifyResult | null
  /** Provider-specific verification */
  tinfoil: TinfoilResult | null
  chutes: ChutesResult | null
  /** Intel Trust Authority appraisal */
  ita: ItaResult | null
  errors: string[]
}

export async function verifyModel(options: VerifyModelOptions = {}): Promise<VerifyModelResult> {
  const model = options.model ?? DEFAULT_MODEL
  const nonce = randomNonce(32)
  const errors: string[] = []

  // 1. Detect provider
  const modelInfo = await detectProvider(model)
  const providerType = getPrimaryProvider(modelInfo)

  // 2. Fetch attestation
  const report = await fetchAttestation(model, nonce)
  if (report.error) throw new Error(`Attestation API error: ${JSON.stringify(report.error)}`)

  const detectedProvider = detectProviderFromAttestation(report as Record<string, unknown>)
  const provider = providerType !== 'unknown' ? providerType : detectedProvider

  // 3. Extract attestation data based on format
  const attestation = selectAttestation(report)
  const gatewayAtt = report.gateway_attestation ?? null
  const signingAddress = attestation.signing_address ?? null
  const hardware: string[] = []

  // 4. Light mode — cloud API verification
  let tdxResult: AttestationResult['tdx'] | null = null
  let reportDataResult: AttestationResult['reportData'] = null
  let gpuResult: GpuResult | null = null
  let composeResult: ComposeResult | null = null
  let sigstoreLinks: AttestationResult['sigstore'] = []

  // TDX quote
  if (attestation.intel_quote) {
    try {
      tdxResult = await checkTdxQuote(attestation.intel_quote)
      if (tdxResult.verified) hardware.push('INTEL_TDX')
    } catch (e) {
      errors.push(`TDX verification failed: ${e}`)
    }
  }

  // Report data binding
  if (tdxResult?.quote?.body?.reportdata && signingAddress) {
    reportDataResult = checkReportData(
      signingAddress,
      attestation.signing_algo ?? 'ecdsa',
      nonce,
      tdxResult.quote.body.reportdata,
    )
  }

  // GPU
  if (attestation.nvidia_payload) {
    try {
      gpuResult = await checkGpu(attestation.nvidia_payload, nonce)
      if (gpuResult.verdict === 'true' || gpuResult.verdict === 'PASS') hardware.push('NVIDIA_CC')
    } catch (e) {
      errors.push(`GPU verification failed: ${e}`)
    }
  }

  // Compose manifest
  if (tdxResult?.quote?.body?.mrconfig) {
    const tcbInfo = attestation.info?.tcb_info
    const tcb = typeof tcbInfo === 'string' ? JSON.parse(tcbInfo) : tcbInfo
    const appCompose = tcb?.app_compose as string | undefined
    if (appCompose) {
      composeResult = await checkCompose(appCompose, tdxResult.quote.body.mrconfig)
      if (!options.skipSigstore) {
        sigstoreLinks = await checkSigstore(appCompose)
      }
    }
  }

  // 5. Deep mode — dstack-verifier Docker
  let deepResult: VerifyModelResult['deep'] = null
  const useDeep = options.deep ?? (await isDstackAvailable(options.dstackUrl))

  if (useDeep) {
    try {
      if (provider === 'phala' && modelInfo.appId) {
        const dr = await deepVerifyPhala(modelInfo.appId, options.dstackUrl)
        deepResult = { available: true, ...dr }
      } else if (provider === 'near-ai' || provider === 'phala') {
        const dr = await deepVerifyNearAI(attestation, gatewayAtt, options.dstackUrl)
        deepResult = { available: true, ...dr }
      } else {
        deepResult = { available: true, components: [], allValid: false }
        errors.push(`Deep verification not yet supported for provider: ${provider}`)
      }
    } catch (e) {
      deepResult = { available: true, components: [], allValid: false }
      errors.push(`Deep verification failed: ${e}`)
    }
  } else {
    deepResult = { available: false, components: [], allValid: false }
  }

  // 6. Provider-specific verification
  let tinfoilResult: TinfoilResult | null = null
  let chutesResult: ChutesResult | null = null

  if (provider === 'tinfoil' && attestation.intel_quote) {
    try {
      // Tinfoil models need repo for manifest comparison — get from model info or config
      const repo = (modelInfo as unknown as Record<string, unknown>).repo as string | undefined
      tinfoilResult = await verifyTinfoil(attestation.intel_quote, repo)
      if (!tinfoilResult.verified) errors.push(`Tinfoil policy: ${tinfoilResult.errors.join(', ')}`)
    } catch (e) {
      errors.push(`Tinfoil verification failed: ${e}`)
    }
  }

  if (provider === 'chutes' && attestation.intel_quote) {
    try {
      const allAtts = (report as unknown as Record<string, unknown>).all_attestations as Array<Record<string, unknown>> | undefined
      const att = allAtts?.[0]
      if (att) {
        chutesResult = await verifyChutes({
          instanceId: (att.instance_id ?? '') as string,
          quote: attestation.intel_quote,
          nonce: (att.nonce ?? nonce) as string,
          e2ePubkey: (att.e2e_pubkey ?? '') as string,
          gpuEvidence: att.gpu_evidence as ChutesEvidence['gpuEvidence'],
        })
        if (!chutesResult.verified) errors.push(`Chutes: ${chutesResult.errors.join(', ')}`)
      }
    } catch (e) {
      errors.push(`Chutes verification failed: ${e}`)
    }
  }

  // 7. Intel Trust Authority (optional)
  let itaResult: ItaResult | null = null
  if (attestation.intel_quote && options.itaApiKey) {
    try {
      itaResult = await verifyWithIta(attestation.intel_quote, options.itaApiKey)
    } catch (e) {
      errors.push(`ITA appraisal failed: ${e}`)
    }
  }

  // 8. On-chain DCAP
  let onchainResult: OnchainVerifyResult | null = null
  if (!options.skipOnchain && attestation.intel_quote) {
    try {
      onchainResult = await verifyOnchain(attestation.intel_quote, options.network)
    } catch (e) {
      errors.push(`On-chain verification failed: ${e}`)
    }
  }

  // 9. Determine overall verification status
  const lightValid = tdxResult?.verified ?? false
  const deepValid = deepResult?.available ? deepResult.allValid : true // skip if unavailable
  const providerValid = provider === 'tinfoil' ? (tinfoilResult?.verified ?? true) : true
  const chutesValid = provider === 'chutes' ? (chutesResult?.verified ?? true) : true
  const verified = lightValid && deepValid && providerValid && chutesValid

  return {
    verified,
    model,
    provider,
    hardware,
    signingAddress,
    nonce,
    light: { tdx: tdxResult, reportData: reportDataResult, gpu: gpuResult, compose: composeResult, sigstore: sigstoreLinks },
    deep: deepResult,
    onchain: onchainResult,
    tinfoil: tinfoilResult,
    chutes: chutesResult,
    ita: itaResult,
    errors,
  }
}

// ---------------------------------------------------------------------------
// verify(chatId) — the one-liner
// ---------------------------------------------------------------------------

export interface VerifyOptions extends VerifyModelOptions {
  /** RedPill API key (required for signature verification) */
  apiKey: string
  /** Original request body JSON (optional, for hash comparison) */
  requestBody?: string
  /** Original response text (optional, for hash comparison) */
  responseText?: string
}

export interface VerifyResult extends VerifyModelResult {
  chatId: string
  signature: {
    valid: boolean
    recoveredAddress: string
    requestHashMatch: boolean | null
    responseHashMatch: boolean | null
  }
}

/**
 * Verify an existing chat response. The one-liner API.
 *
 * @example
 * ```typescript
 * const openai = new OpenAI({ baseURL: 'https://api.redpill.ai/v1', apiKey: 'sk-xxx' })
 * const response = await openai.chat.completions.create({ model: 'phala/gpt-oss-120b', messages })
 *
 * const proof = await verify(response.id, { model: 'phala/gpt-oss-120b', apiKey: 'sk-xxx' })
 * console.log(proof.verified, proof.signature.valid)
 * ```
 */
export async function verify(chatId: string, options: VerifyOptions): Promise<VerifyResult> {
  const model = options.model ?? DEFAULT_MODEL

  // 1. Fetch and verify signature
  const sig = await fetchSignature(chatId, model, options.apiKey)
  if (sig.error) throw new Error(`Signature error: ${sig.error}`)

  const parts = sig.text.split(':')
  const [reqHashServer, respHashServer] = parts.length === 3 ? [parts[1], parts[2]] : [parts[0], parts[1]]

  let requestHashMatch: boolean | null = null
  let responseHashMatch: boolean | null = null
  if (options.requestBody) requestHashMatch = (await sha256(options.requestBody)) === reqHashServer
  if (options.responseText) responseHashMatch = (await sha256(options.responseText)) === respHashServer

  const recovered = await recoverMessageAddress({ message: sig.text, signature: sig.signature as Hex })
  const signatureValid = recovered.toLowerCase() === sig.signing_address.toLowerCase()

  // 2. Run full model verification
  const modelResult = await verifyModel(options)

  return {
    ...modelResult,
    chatId,
    verified: modelResult.verified && signatureValid,
    signature: {
      valid: signatureValid,
      recoveredAddress: recovered,
      requestHashMatch,
      responseHashMatch,
    },
  }
}
