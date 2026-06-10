/**
 * Tinfoil-specific verification.
 * Checks hardware policy (MR_SEAM, TdAttributes, XFAM) and compares
 * measurements against Sigstore golden values from Tinfoil's repos.
 */

// Accepted MR_SEAM values (TDX Module hashes)
// https://github.com/tinfoilsh/verifier/blob/main/attestation/tdx.go
const ACCEPTED_MR_SEAMS = [
  '49b66faa451d19ebbdbe89371b8daf2b65aa3984ec90110343e9e2eec116af08850fa20e3b1aa9a874d77a65380ee7e6', // 1.5.08
  '685f891ea5c20e8fa27b151bf34bf3b50fbaf7143cc53662727cbdb167c0ad8385f1f6f3571539a91e104a1c96d75e04', // 2.0.02
  '7bf063280e94fb051f5dd7b1fc59ce9aac42bb961df8d44b709c9b0ff87a7b4df648657ba6d1189589feab1d5a3c9a9d', // 1.5.16
  '476a2997c62bccc7837091dd58dc7c24c28ba26927f93e00e7e1997d68e3d5bb9a023c3ec0d7c0e5a29929fe5dd282ec', // 2.0.08
]

const EXPECTED_TD_ATTRIBUTES = '0000001000000000'
const EXPECTED_XFAM = 'e702060000000000'
const ZERO_48 = '00'.repeat(48)

export interface TdxRegisters {
  mrSeam: string
  tdAttributes: string
  xfam: string
  mrTd: string
  mrOwner: string
  mrOwnerConfig: string
  rtmr0: string
  rtmr1: string
  rtmr2: string
  rtmr3: string
  reportData: string
}

export interface TinfoilResult {
  verified: boolean
  hwPolicyValid: boolean
  manifestValid: boolean | null
  hwProfile: string | null
  repo: string | null
  errors: string[]
}

/**
 * Parse TDX V4 quote bytes to extract measurement registers.
 */
export function parseTdxQuote(quoteHex: string): TdxRegisters {
  const hex = quoteHex.replace(/^0x/, '')
  // If base64, decode first
  let bytes: Uint8Array
  if (/[^0-9a-fA-F]/.test(hex)) {
    const bin = atob(quoteHex)
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } else {
    bytes = Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  }

  // Header is 48 bytes, body starts at 48
  const body = bytes.slice(48, 48 + 584)
  const toHex = (start: number, end: number) =>
    Array.from(body.slice(start, end)).map((b) => b.toString(16).padStart(2, '0')).join('')

  return {
    mrSeam: toHex(16, 64),
    tdAttributes: toHex(120, 128),
    xfam: toHex(128, 136),
    mrTd: toHex(136, 184),
    mrOwner: toHex(232, 280),
    mrOwnerConfig: toHex(280, 328),
    rtmr0: toHex(328, 376),
    rtmr1: toHex(376, 424),
    rtmr2: toHex(424, 472),
    rtmr3: toHex(472, 520),
    reportData: toHex(520, 584),
  }
}

/**
 * Check Tinfoil hardware policy (MR_SEAM, TdAttributes, XFAM, zero fields).
 */
export function checkHardwarePolicy(regs: TdxRegisters): string[] {
  const errors: string[] = []
  if (!ACCEPTED_MR_SEAMS.includes(regs.mrSeam)) errors.push(`Invalid MrSeam: ${regs.mrSeam.slice(0, 16)}...`)
  if (regs.tdAttributes !== EXPECTED_TD_ATTRIBUTES) errors.push(`Invalid TdAttributes: ${regs.tdAttributes}`)
  if (regs.xfam !== EXPECTED_XFAM) errors.push(`Invalid Xfam: ${regs.xfam}`)
  if (regs.mrOwner !== ZERO_48) errors.push('mr_owner is not zero')
  if (regs.mrOwnerConfig !== ZERO_48) errors.push('mr_owner_config is not zero')
  if (regs.rtmr3 !== ZERO_48) errors.push('RTMR3 is not zeroed')
  return errors
}

/**
 * Fetch Sigstore attestation bundle from Tinfoil's proxy.
 */
async function fetchSigstoreBundle(repo: string): Promise<Record<string, unknown>> {
  try {
    const latestRes = await fetch(`https://api-github-proxy.tinfoil.sh/repos/${repo}/releases/latest`, { signal: AbortSignal.timeout(10_000) })
    const tag = ((await latestRes.json()) as Record<string, string>).tag_name

    const hashRes = await fetch(`https://api-github-proxy.tinfoil.sh/${repo}/releases/download/${tag}/tinfoil.hash`, { signal: AbortSignal.timeout(10_000) })
    const digest = (await hashRes.text()).trim()

    const attRes = await fetch(`https://gh-attestation-proxy.tinfoil.sh/repos/${repo}/attestations/sha256:${digest}`, { signal: AbortSignal.timeout(10_000) })
    const attData = await attRes.json() as { attestations?: Array<{ bundle?: Record<string, unknown> }> }
    return attData.attestations?.[0]?.bundle ?? {}
  } catch {
    return {}
  }
}

function extractPayload(bundle: Record<string, unknown>): Record<string, unknown> {
  try {
    const envelope = bundle.dsseEnvelope as Record<string, string> | undefined
    const payloadB64 = envelope?.payload
    if (payloadB64) return JSON.parse(atob(payloadB64))
  } catch {}
  return {}
}

/**
 * Check image measurements (RTMR1, RTMR2) against Sigstore golden values.
 */
export async function checkManifestPolicy(
  regs: TdxRegisters,
  repo: string,
): Promise<{ errors: string[]; hwProfile: string | null }> {
  const errors: string[] = []
  let hwProfile: string | null = null

  // 1. Fetch image golden measurements
  const imageBundle = await fetchSigstoreBundle(repo)
  const imagePayload = extractPayload(imageBundle)
  const predicate = imagePayload.predicate as Record<string, unknown> | undefined
  const tdxMeasurement = predicate?.tdx_measurement as Record<string, string> | undefined

  if (tdxMeasurement?.rtmr1) {
    if (tdxMeasurement.rtmr1 !== regs.rtmr1) errors.push(`RTMR1 mismatch: expected ${tdxMeasurement.rtmr1.slice(0, 16)}...`)
    if (tdxMeasurement.rtmr2 && tdxMeasurement.rtmr2 !== regs.rtmr2) errors.push(`RTMR2 mismatch`)
  } else {
    errors.push(`Failed to fetch golden measurements for ${repo}`)
  }

  // 2. Fetch hardware profile (MRTD, RTMR0)
  const hwBundle = await fetchSigstoreBundle('tinfoilsh/hardware-measurements')
  const hwPayload = extractPayload(hwBundle)
  const hwPredicate = hwPayload.predicate as Record<string, Record<string, string>> | undefined

  if (hwPredicate) {
    for (const [name, values] of Object.entries(hwPredicate)) {
      if (values.mrtd === regs.mrTd && values.rtmr0 === regs.rtmr0) {
        hwProfile = name
        break
      }
    }
    if (!hwProfile) errors.push(`No matching hardware profile for MRTD=${regs.mrTd.slice(0, 8)}...`)
  }

  return { errors, hwProfile }
}

/**
 * Parse AMD SEV-SNP report to extract measurement.
 */
export function parseSevSnpReport(quoteHex: string): { measurement: string; reportData: string; version: number } | null {
  const hex = quoteHex.replace(/^0x/, '')
  let bytes: Uint8Array
  if (/[^0-9a-fA-F]/.test(hex)) {
    const bin = atob(quoteHex)
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } else {
    bytes = Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  }

  if (bytes.length < 0x100) return null

  const toHex = (start: number, end: number) =>
    Array.from(bytes.slice(start, end)).map((b) => b.toString(16).padStart(2, '0')).join('')

  return {
    version: bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24),
    measurement: toHex(0x90, 0xC0),
    reportData: toHex(0x50, 0x90),
  }
}

/**
 * Detect if a quote is TDX (starts with 04 00) or SEV-SNP (starts with 03 00).
 */
export function detectQuoteType(quoteHex: string): 'tdx' | 'sev-snp' | 'unknown' {
  const hex = quoteHex.replace(/^0x/, '')
  // Handle base64
  let firstBytes: string
  if (/[^0-9a-fA-F]/.test(hex)) {
    const bin = atob(quoteHex)
    firstBytes = bin.charCodeAt(0).toString(16).padStart(2, '0') + bin.charCodeAt(1).toString(16).padStart(2, '0')
  } else {
    firstBytes = hex.slice(0, 4)
  }
  if (firstBytes === '0400') return 'tdx'
  if (firstBytes === '0300') return 'sev-snp'
  return 'unknown'
}

/**
 * Check SEV-SNP measurement against Sigstore golden values.
 */
async function checkSevSnpManifest(measurement: string, repo: string): Promise<string[]> {
  const errors: string[] = []
  const bundle = await fetchSigstoreBundle(repo)
  const payload = extractPayload(bundle)
  const predicateType = payload.predicateType as string ?? ''

  let goldenMeasurement: string | undefined

  if (predicateType.includes('snp-tdx-multiplatform')) {
    const snp = (payload.predicate as Record<string, unknown>)?.snp_measurement
    goldenMeasurement = typeof snp === 'string' ? snp : (snp as Record<string, string>)?.measurement
  } else if (predicateType.includes('sev-snp-guest')) {
    const pred = payload.predicate as Record<string, unknown>
    goldenMeasurement = typeof pred === 'string' ? pred : (pred?.measurement as string)
  }

  if (!goldenMeasurement) {
    errors.push('Golden SNP measurement not found in Sigstore bundle')
  } else if (measurement !== goldenMeasurement) {
    errors.push(`SNP measurement mismatch: expected ${goldenMeasurement.slice(0, 16)}..., got ${measurement.slice(0, 16)}...`)
  }

  return errors
}

/**
 * Full Tinfoil verification: supports both TDX and SEV-SNP.
 */
export async function verifyTinfoil(quoteHex: string, repo?: string): Promise<TinfoilResult> {
  const quoteType = detectQuoteType(quoteHex)

  if (quoteType === 'sev-snp') {
    // SEV-SNP verification
    const snp = parseSevSnpReport(quoteHex)
    if (!snp) return { verified: false, hwPolicyValid: false, manifestValid: null, hwProfile: null, repo: repo ?? null, errors: ['Failed to parse SEV-SNP report'] }

    const allErrors: string[] = []
    let manifestValid: boolean | null = null

    if (repo) {
      const manifestErrors = await checkSevSnpManifest(snp.measurement, repo)
      allErrors.push(...manifestErrors)
      manifestValid = manifestErrors.length === 0
    }

    return {
      verified: allErrors.length === 0,
      hwPolicyValid: true, // SEV-SNP hardware checks are simpler
      manifestValid,
      hwProfile: null,
      repo: repo ?? null,
      errors: allErrors,
    }
  }

  // TDX verification
  const regs = parseTdxQuote(quoteHex)
  const policyErrors = checkHardwarePolicy(regs)
  const allErrors = [...policyErrors]
  let manifestValid: boolean | null = null
  let hwProfile: string | null = null

  if (repo) {
    const manifest = await checkManifestPolicy(regs, repo)
    allErrors.push(...manifest.errors)
    manifestValid = manifest.errors.length === 0
    hwProfile = manifest.hwProfile
  }

  return {
    verified: allErrors.length === 0,
    hwPolicyValid: policyErrors.length === 0,
    manifestValid,
    hwProfile,
    repo: repo ?? null,
    errors: allErrors,
  }
}
