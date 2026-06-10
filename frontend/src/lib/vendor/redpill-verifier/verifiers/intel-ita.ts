/**
 * Intel Trust Authority (ITA) remote appraisal.
 * Optional secondary verification of TDX quotes via Intel's own attestation service.
 * Requires INTEL_TRUST_AUTHORITY_API_KEY.
 */

import { decodeJwtPayload } from '../utils.js'

const ITA_URL = 'https://api.trustauthority.intel.com/appraisal/v2/attest'

export interface ItaResult {
  appraised: boolean
  claims: Record<string, unknown> | null
  error: string | null
}

/**
 * Convert a hex or base64 TDX quote to base64 for ITA submission.
 */
function toBase64Quote(quote: string): string {
  const clean = quote.replace(/^0x/, '')
  let bytes: Uint8Array

  // Check if hex or base64
  if (/[^0-9a-fA-F]/.test(clean)) {
    // Already base64-ish, decode and re-encode cleanly
    const bin = atob(quote)
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } else {
    bytes = Uint8Array.from(clean.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  }

  // Encode to base64
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Appraise a TDX quote using Intel Trust Authority.
 * Returns the decoded JWT claims from ITA, or null if unavailable.
 */
export async function verifyWithIta(
  intelQuote: string,
  apiKey?: string,
): Promise<ItaResult> {
  const key = apiKey ?? (typeof process !== 'undefined' ? process.env?.INTEL_TRUST_AUTHORITY_API_KEY : undefined)
  if (!key) {
    return { appraised: false, claims: null, error: 'No ITA API key (set INTEL_TRUST_AUTHORITY_API_KEY)' }
  }

  try {
    const quoteBase64 = toBase64Quote(intelQuote)

    const res = await fetch(ITA_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'x-api-key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tdx: { quote: quoteBase64 } }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      return { appraised: false, claims: null, error: `ITA returned ${res.status}` }
    }

    const data = await res.json() as { token?: string }
    if (!data.token) {
      return { appraised: false, claims: null, error: 'No token in ITA response' }
    }

    const claims = decodeJwtPayload(data.token)
    return { appraised: true, claims, error: null }
  } catch (e) {
    return { appraised: false, claims: null, error: `ITA appraisal failed: ${e}` }
  }
}
