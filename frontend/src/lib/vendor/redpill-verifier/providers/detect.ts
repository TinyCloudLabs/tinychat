/**
 * Auto-detect which TEE provider backs a model via the Redpill API.
 */

import { API_BASE } from '../constants.js'

export type ProviderType = 'phala' | 'near-ai' | 'tinfoil' | 'chutes' | 'unknown'

export interface ModelInfo {
  id: string
  providers: string[]
  appId: string | null
  attestationType: string | null
}

let modelCache: Map<string, ModelInfo> | null = null
let cacheTime = 0
const CACHE_TTL = 60_000 // 1 minute

/**
 * Fetch model list from Redpill API and cache it.
 */
async function fetchModels(): Promise<Map<string, ModelInfo>> {
  if (modelCache && Date.now() - cacheTime < CACHE_TTL) return modelCache

  const res = await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(15_000) })
  const data = await res.json() as { data: Array<Record<string, unknown>> }
  const models = data.data ?? data

  const map = new Map<string, ModelInfo>()
  for (const m of models as Array<Record<string, unknown>>) {
    const id = m.id as string
    const providers = (m.providers ?? []) as string[]
    const metadata = (m.metadata ?? {}) as Record<string, string>
    map.set(id, {
      id,
      providers,
      appId: metadata.appid ?? null,
      attestationType: null,
    })
  }

  modelCache = map
  cacheTime = Date.now()
  return map
}

/**
 * Detect the TEE provider for a given model.
 */
export async function detectProvider(modelId: string): Promise<ModelInfo> {
  const models = await fetchModels()
  const info = models.get(modelId)

  if (!info) {
    return { id: modelId, providers: [], appId: null, attestationType: null }
  }

  return info
}

/**
 * Get the primary provider type for a model.
 */
export function getPrimaryProvider(info: ModelInfo): ProviderType {
  if (info.providers.includes('phala') || info.appId) return 'phala'
  if (info.providers.includes('near-ai')) return 'near-ai'
  if (info.providers.includes('tinfoil')) return 'tinfoil'
  if (info.providers.includes('chutes')) return 'chutes'
  return 'unknown'
}

/**
 * Detect provider from the attestation response format itself.
 * Useful when the model list doesn't have provider info.
 */
export function detectProviderFromAttestation(data: Record<string, unknown>): ProviderType {
  if (data.attestation_type === 'chutes') return 'chutes'
  if (data.gateway_attestation && data.model_attestations) {
    // Could be Phala native or NearAI — check for compose_manager_attestation
    const models = data.model_attestations as Array<Record<string, unknown>>
    if (models[0]?.compose_manager_attestation) return 'near-ai'
    return 'phala' // Default for gateway+model format
  }
  if (data.all_attestations) return 'chutes'
  if (data.signing_address && data.intel_quote) return 'phala'
  return 'unknown'
}
