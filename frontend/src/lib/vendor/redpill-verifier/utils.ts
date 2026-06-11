import type { AttestationReport, RawAttestation } from './types.js'

/**
 * Browser-compatible SHA256 hash.
 */
export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Generate a cryptographically secure random hex nonce.
 */
export function randomNonce(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Decode the payload section of a JWT token.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
  const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(json)
}

/**
 * Normalize attestation response formats.
 * Handles: model_attestations[], all_attestations[], gateway_attestation, flat.
 */
export function selectAttestation(
  report: AttestationReport,
  signingAddress?: string,
): RawAttestation {
  // Try model_attestations first (two-layer format)
  for (const key of ['model_attestations', 'all_attestations'] as const) {
    const items = report[key]
    if (Array.isArray(items)) {
      // Prefer matching signing_address if provided
      if (signingAddress) {
        const match = items.find(
          (a) => a.signing_address?.toLowerCase() === signingAddress.toLowerCase(),
        )
        if (match) return match
      }
      // Otherwise return first with signing_address or intel_quote
      const first = items.find((a) => typeof a === 'object' && ('signing_address' in a || 'intel_quote' in a))
      if (first) return first
    }
  }

  // Try gateway_attestation
  const gw = report.gateway_attestation
  if (gw && typeof gw === 'object') return gw

  // Flat format — report itself is the attestation
  return report as unknown as RawAttestation
}
