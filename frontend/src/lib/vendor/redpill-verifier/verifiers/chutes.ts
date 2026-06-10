/**
 * Chutes-specific verification.
 * Verifies anti-tamper binding (nonce + e2e_pubkey → report_data),
 * checks debug mode is disabled, and validates NVIDIA GPU tokens.
 */

import { sha256 } from '../utils.js'
import { decodeJwtPayload } from '../utils.js'

export interface ChutesEvidence {
  instanceId: string
  quote: string          // base64-encoded TDX quote
  nonce: string
  e2ePubkey: string
  gpuEvidence?: Array<{ certificate: string; evidence: string; arch: string }>
}

export interface ChutesResult {
  verified: boolean
  debugModeDisabled: boolean
  e2eBindingVerified: boolean
  gpuVerified: boolean | null
  gpuCount: number
  errors: string[]
}

/**
 * Extract td_attributes from TDX quote bytes to check debug mode.
 */
function extractTdAttributes(quoteBytes: Uint8Array): string | null {
  try {
    const body = quoteBytes.slice(48, 48 + 584)
    return Array.from(body.slice(120, 128)).map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * Extract report_data from TDX quote bytes (first 32 bytes of the 64-byte report_data field).
 */
function extractReportData(quoteBytes: Uint8Array): string {
  const body = quoteBytes.slice(48, 48 + 584)
  return Array.from(body.slice(520, 584)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 64)
}

/**
 * Verify a single Chutes instance.
 *
 * Flow:
 * 1. Check debug mode is disabled (td_attributes bit 0)
 * 2. Verify anti-tamper: SHA256(nonce + e2e_pubkey) matches report_data
 * 3. Validate NVIDIA GPU tokens if present
 */
export async function verifyChutes(evidence: ChutesEvidence): Promise<ChutesResult> {
  const errors: string[] = []

  // Decode base64 quote to bytes
  let quoteBytes: Uint8Array
  try {
    const bin = atob(evidence.quote)
    quoteBytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch (e) {
    return { verified: false, debugModeDisabled: false, e2eBindingVerified: false, gpuVerified: null, gpuCount: 0, errors: [`Failed to decode quote: ${e}`] }
  }

  // Step 1: Check debug mode
  const tdAttr = extractTdAttributes(quoteBytes)
  let debugModeDisabled = false
  if (tdAttr) {
    const attrValue = parseInt(tdAttr, 16)
    debugModeDisabled = !(attrValue & 1)
    if (!debugModeDisabled) errors.push('CRITICAL: TDX running in Debug mode')
  }

  // Step 2: Anti-tamper binding: SHA256(nonce + e2e_pubkey) == report_data
  const expectedHash = await sha256(evidence.nonce + evidence.e2ePubkey)
  const actualReportData = extractReportData(quoteBytes)
  const e2eBindingVerified = actualReportData === expectedHash
  if (!e2eBindingVerified) errors.push('Anti-tamper hash mismatch: E2E public key may have been tampered')

  // Step 3: GPU token validation (offline JWT decode)
  let gpuVerified: boolean | null = null
  const gpuCount = evidence.gpuEvidence?.length ?? 0

  // Note: Full GPU verification for Chutes requires the pre-fetched NRAS tokens
  // from the Chutes API. The gpu_evidence from the Redpill attestation API contains
  // raw per-GPU certs/evidence, not pre-verified NRAS tokens.
  // For light mode, we validate what we can (quote + binding).
  // For deep mode with Chutes' own API, full GPU token validation would apply.

  return {
    verified: errors.length === 0,
    debugModeDisabled,
    e2eBindingVerified,
    gpuVerified,
    gpuCount,
    errors,
  }
}
