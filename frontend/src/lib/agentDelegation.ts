// Agent delegation mint + courier (Milestone E, §5).
//
// Decision 1 (DIRECT delegation): after SIWE sign-in, on first agent use, the
// FRONTEND mints ONE tinycloud.sql delegation from the user's wallet to the AGENT
// DID (not the backend) using the user's existing tcw session. tinychat couriers
// the serialized delegation to eliza-service via the backend (POST /api/agent/session)
// but cannot use it (WRONG_DELEGATEE). The backend derives the routing entityId.
//
// Ported from tinycloud-agents/tools/delegate-ui/src/delegate.ts (the live-proven
// mint primitive), minus the DOM UI: the create() call, the lossy-`actions`
// JWT-recovery fix, and the PortableDelegation assembly. Expiry shortened to ≤7d
// (decision 4); the SDK clamps to the session window (~7d) regardless.

// `serializeDelegation` is loaded LAZILY (dynamic import) from @tinycloud/web-sdk
// inside mintAgentDelegation — the only place it runs, in-browser. We deliberately
// do NOT import it at module top level:
//   - a top-level @tinycloud/node-sdk import double-defines web-sdk's
//     `tinycloud-space-modal` custom element in the browser → blank-page crash;
//   - a top-level @tinycloud/web-sdk value import pulls its browser bundle
//     (references HTMLElement at load) → breaks non-DOM contexts like bun test.
// The dynamic web-sdk import reuses the app's ALREADY-loaded copy (a single
// custom-element registration, no collision) and never runs under bun test (the
// real mint is stubbed via `_mint`). The DOM-bound types below are type-only.
import type { Delegation, PortableDelegation, TinyCloudWeb } from "@tinycloud/web-sdk";

/** The frozen agent identity all users delegate to (Layer-1 contract §2). */
export const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";

/** The agent's memory db handle — FIXED (the space varies per user, the path does not). */
export const AGENT_MEMORY_PATH = "xyz.tinycloud.eliza/memory";

/** Default delegation lifetime — ≤7d (decision 4); the SDK clamps to the session window. */
export const AGENT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/admin",
  "tinycloud.capabilities/read",
];

const DEFAULT_HOST = "https://node.tinycloud.xyz";
const CSRF_HEADER = "X-Requested-With";
const CSRF_VALUE = "XMLHttpRequest";

// Decode a url-safe base64 string (handles `-`/`_` and missing padding).
// Browser-safe — no node-only crypto.
function base64UrlDecode(input: string): string {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// web-sdk serializes the top-level `actions` summary field lossily — it emits only
// ["tinycloud.capabilities/read"] even though the signed delegationHeader.Authorization
// JWT grants all the SQL actions. Both the agent's shallow validator and node-sdk's
// useDelegation derive grants from this top-level `actions` array, so an incomplete
// list gets rejected as "no SQL resource". We recover the true grant set from the
// JWT's `att` claim. `actions` is an UNSIGNED summary field, so rewriting it does NOT
// affect the signature inside delegationHeader.
export function actionsFromAuthJwt(authHeader: string): string[] | null {
  try {
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const att = payload?.att;
    if (!att || typeof att !== "object") return null;
    const actions = new Set<string>();
    for (const resource of Object.values(att)) {
      if (resource && typeof resource === "object") {
        for (const ability of Object.keys(resource)) actions.add(ability);
      }
    }
    return actions.size > 0 ? [...actions] : null;
  } catch {
    return null;
  }
}

function toPortableDelegation(
  delegation: Delegation,
  ownerAddress: string,
  chainId: number,
  host: string,
): PortableDelegation {
  // PortableDelegation omits isRevoked; destructure it out before spreading.
  const { isRevoked: _omitted, ...rest } = delegation as Delegation & { isRevoked?: boolean };
  return {
    ...rest,
    delegationHeader: {
      Authorization: delegation.authHeader || `Bearer ${delegation.cid}`,
    },
    ownerAddress,
    chainId,
    host,
  } as PortableDelegation;
}

/**
 * Serialize a PortableDelegation and complete its lossy top-level `actions`
 * summary so it faithfully reflects the grants signed into
 * delegationHeader.Authorization. Only the unsigned `actions` field is touched.
 * Exported for testing.
 */
export function completeSerializedActions(
  portable: PortableDelegation,
  serialize: (d: PortableDelegation) => string,
): string {
  const serialized = serialize(portable);
  const parsed = JSON.parse(serialized);
  const authHeader = parsed?.delegationHeader?.Authorization ?? "";
  parsed.actions = actionsFromAuthJwt(authHeader) ?? SQL_ACTIONS;
  return JSON.stringify(parsed);
}

export interface MintAgentDelegationOptions {
  delegateDID?: string;
  path?: string;
  host?: string;
  expiryMs?: number;
}

/**
 * Mint a tinycloud.sql delegation from the user's wallet to the agent DID.
 * Returns the serialized delegation (with completed actions) ready to courier.
 * Throws on a failed mint (the SDK surfaces a DelegationResult error).
 */
export async function mintAgentDelegation(
  tcw: TinyCloudWeb,
  options: MintAgentDelegationOptions = {},
): Promise<string> {
  const delegateDID = options.delegateDID ?? AGENT_DID;
  const path = options.path ?? AGENT_MEMORY_PATH;
  const host = options.host ?? tcw.hosts?.[0] ?? DEFAULT_HOST;
  const expiryMs = options.expiryMs ?? AGENT_DELEGATION_EXPIRY_MS;

  const space = tcw.space("default");
  const expiry = new Date(Date.now() + expiryMs);
  const result = await space.delegations.create({
    delegateDID,
    path,
    actions: SQL_ACTIONS,
    expiry,
  });

  if (!result.ok) {
    throw new Error(`Failed to mint agent delegation: ${result.error.message}`);
  }

  const ownerAddress = tcw.address() ?? "";
  const chainId = tcw.chainId() ?? 1;
  const portable = toPortableDelegation(result.data, ownerAddress, chainId, host);
  // Lazy: reuse the app's already-loaded web-sdk copy of serializeDelegation so
  // we add NO second custom-element registration, and keep this module DOM-free
  // for bun test (this line only runs during a real in-browser mint).
  const { serializeDelegation } = await import("@tinycloud/web-sdk");
  return completeSerializedActions(portable, serializeDelegation);
}

export interface FreshSignInMintOptions {
  /** OpenKey app name shown in the passkey prompt. */
  appName: string;
  /** OpenKey host for the passkey provider. */
  openkeyHost: string;
  /** TinyCloud hosts (defaults to the SDK's). */
  tinycloudHosts?: string[];
  delegateDID?: string;
  path?: string;
  expiryMs?: number;
}

/**
 * Mint via a FRESH, plain sign-in — the live-proven `delegate-ui` flow.
 *
 * WHY: the app's own session signs in with the app manifest (tinycloud.kv on the
 * app space), so its session key does NOT hold a recap covering tinycloud.sql on
 * `xyz.tinycloud.eliza/memory`. `delegations.create()` then falls back to a
 * WALLET-signed CACAO (CBOR) whose Authorization is NOT a JWT — which the agent's
 * `decodeJwtPayload` normalizer rejects ("Authorization carries no signed
 * capability JWT"). A plain sign-in with NO manifest grants the session key the
 * SDK's broad default recap, so `create()` issues a SESSION-KEY UCAN (a signed
 * JWT in delegationHeader.Authorization) — exactly the proven on-disk shape.
 *
 * The instance is EPHEMERAL: no `sessionStorage`, so it never overwrites the
 * app's persisted session for this address; torn down via `cleanup()` after mint.
 * Dynamic imports keep this module DOM-free for bun test (the real flow only runs
 * in-browser; unit tests stub the mint via `_mint`).
 */
export async function mintAgentDelegationViaFreshSignIn(
  options: FreshSignInMintOptions,
): Promise<string> {
  const { connectWallet } = await import("@tinyboilerplate/client");
  const { TinyCloudWeb, BrowserSessionStorage } = await import("@tinycloud/web-sdk");

  const { web3Provider } = await connectWallet({
    appName: options.appName,
    host: options.openkeyHost,
  });

  // CRITICAL: isolate this sign-in's session storage. With NO sessionStorage the
  // SDK falls back to the shared localStorage-backed BrowserSessionStorage and
  // RESTORES the app's already-persisted session for this address — whose SIWE
  // recap only covers the app manifest (tinycloud.kv). create() would then find
  // SQL is not a subset of the recap and fall back to a wallet CACAO (CBOR) the
  // agent rejects. An in-memory store has nothing to restore → signIn() performs
  // a FRESH SIWE whose broad default recap includes tinycloud.sql, so create()
  // issues a session-key UCAN JWT. In-memory also means we never touch (clobber)
  // the app's persisted session.
  const memory = new Map<string, string>();
  const ephemeralStorage: Storage = {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    getItem: (k: string) => (memory.has(k) ? (memory.get(k) as string) : null),
    key: (i: number) => Array.from(memory.keys())[i] ?? null,
    removeItem: (k: string) => {
      memory.delete(k);
    },
    setItem: (k: string, v: string) => {
      memory.set(k, String(v));
    },
  };

  // Match delegate-ui's minimal config: provider + hosts, NO manifest (→ broad
  // default recap incl. tinycloud.sql → session-key UCAN JWT). Isolated, in-memory
  // session storage prevents restoring/clobbering the app session (see above).
  const tcw = new TinyCloudWeb({
    providers: { web3: { driver: web3Provider } },
    ...(options.tinycloudHosts ? { tinycloudHosts: options.tinycloudHosts } : {}),
    sessionStorage: new BrowserSessionStorage({ storage: ephemeralStorage }),
  });

  try {
    await tcw.signIn();
    return await mintAgentDelegation(tcw, {
      delegateDID: options.delegateDID,
      path: options.path,
      host: options.tinycloudHosts?.[0],
      expiryMs: options.expiryMs,
    });
  } finally {
    try {
      // In-memory teardown ONLY — never signOut() (that clears the shared
      // BrowserSessionStorage and would log the user out of the app).
      tcw.cleanup?.();
    } catch {
      /* best-effort */
    }
  }
}

export interface EnsureAgentSessionDeps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  getToken: () => string | null;
  /** Optional tinychat thread id bound to this session (B keys summaries by room). */
  roomId?: string;
  /** Override the agent DID (tests). */
  delegateDID?: string;
  /** Skip the liveness check and force a fresh mint (re-mint UX). */
  force?: boolean;
  /** Test-only seam: override the mint step (defaults to mintAgentDelegation). */
  _mint?: (tcw: TinyCloudWeb) => Promise<string>;
}

export type AgentSessionStatus = "active" | "expired" | "stale" | "none";

// Per-address cache so the interactive passkey mint runs at most once per session.
const sessionCache = new Map<string, AgentSessionStatus>();

/** Clear the in-memory agent-session cache (e.g. on sign-out). */
export function clearAgentSessionCache(): void {
  sessionCache.clear();
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    [CSRF_HEADER]: CSRF_VALUE,
  };
}

/**
 * Ensure the user has a live delegation registered with eliza-service.
 *
 * Lazy + cached: checks GET /api/agent/session first; only mints (interactive
 * passkey) when the delegation is missing/expired/stale, then couriers it via
 * POST /api/agent/session. Returns the resulting status. Re-mint UX keys off the
 * signed expiry surfaced by the status endpoint (decision 4), not mint+7d.
 */
export async function ensureAgentSession(
  deps: EnsureAgentSessionDeps,
): Promise<AgentSessionStatus> {
  const token = deps.getToken();
  if (!token) throw new Error("Not authenticated. Please sign in.");

  const address = deps.tcw.address() ?? "anon";
  if (!deps.force && sessionCache.get(address) === "active") return "active";

  const base = deps.backendUrl.replace(/\/$/, "");

  if (!deps.force) {
    try {
      const res = await fetch(`${base}/api/agent/session`, {
        method: "GET",
        headers: authHeaders(token),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: AgentSessionStatus };
        if (body.status === "active") {
          sessionCache.set(address, "active");
          return "active";
        }
      }
    } catch {
      // Liveness probe failed (offline / eliza unreachable) — fall through to mint.
    }
  }

  // Mint (interactive passkey) + courier.
  const mint = deps._mint ?? ((tcw: TinyCloudWeb) => mintAgentDelegation(tcw, { delegateDID: deps.delegateDID }));
  const serialized = await mint(deps.tcw);
  const res = await fetch(`${base}/api/agent/session`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ serialized, ...(deps.roomId ? { roomId: deps.roomId } : {}) }),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      detail = err.message ?? err.error ?? detail;
    } catch {
      // non-JSON error body
    }
    throw new Error(`Failed to register agent session (${res.status}): ${detail}`);
  }

  const body = (await res.json()) as { status?: AgentSessionStatus };
  const status = body.status ?? "active";
  sessionCache.set(address, status);
  return status;
}
