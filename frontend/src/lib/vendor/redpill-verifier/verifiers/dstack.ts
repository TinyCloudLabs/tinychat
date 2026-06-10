/**
 * Deep verification via dstack-verifier Docker service.
 * Replays boot measurements using QEMU to independently verify TDX quotes.
 * Trust: only Intel silicon. Requires Docker running dstack-verifier.
 */

export interface DstackResult {
  isValid: boolean
  quoteVerified: boolean
  eventLogVerified: boolean
  osImageHashVerified: boolean
  tcbStatus: string | null
  advisoryIds: string[]
  appInfo: Record<string, unknown> | null
  reason: string | null
}

export interface DstackVerifierOptions {
  /** URL of the dstack-verifier service (default: http://localhost:8080) */
  serviceUrl?: string
  /** Timeout in ms (default: 30000) */
  timeout?: number
}

const DEFAULT_URL = 'http://localhost:8080'

/**
 * Check if the dstack-verifier Docker service is available.
 */
export async function isDstackAvailable(serviceUrl = DEFAULT_URL): Promise<boolean> {
  try {
    const res = await fetch(`${serviceUrl}/`, { signal: AbortSignal.timeout(3000) })
    // dstack-verifier returns 404 on root but responds — that means it's running
    return true
  } catch {
    return false
  }
}

/**
 * Verify a TDX quote using the dstack-verifier Docker service.
 * This is the "deep" verification mode — QEMU replays the boot measurement chain.
 */
export async function verifyWithDstack(
  quote: string,
  eventLog: string,
  vmConfig: string,
  options: DstackVerifierOptions = {},
): Promise<DstackResult> {
  const url = options.serviceUrl ?? DEFAULT_URL
  const timeout = options.timeout ?? 30_000

  const body = JSON.stringify({
    quote,
    event_log: typeof eventLog === 'string' ? eventLog : JSON.stringify(eventLog),
    vm_config: typeof vmConfig === 'string' ? vmConfig : JSON.stringify(vmConfig),
  })

  const res = await fetch(`${url}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeout),
  })

  if (!res.ok) {
    throw new Error(`dstack-verifier returned ${res.status}: ${await res.text()}`)
  }

  const data = await res.json() as Record<string, unknown>
  const details = (data.details ?? {}) as Record<string, unknown>

  return {
    isValid: data.is_valid as boolean ?? false,
    quoteVerified: details.quote_verified as boolean ?? false,
    eventLogVerified: details.event_log_verified as boolean ?? false,
    osImageHashVerified: details.os_image_hash_verified as boolean ?? false,
    tcbStatus: details.tcb_status as string | null ?? null,
    advisoryIds: (details.advisory_ids ?? []) as string[],
    appInfo: (details.app_info ?? null) as Record<string, unknown> | null,
    reason: data.reason as string | null ?? null,
  }
}
