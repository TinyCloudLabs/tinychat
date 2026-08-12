import { createHash, randomBytes } from "node:crypto";
import type {
  CredentialAccessPurpose,
  CredentialSecret,
  CredentialStore,
  OAuthCredentialSecret,
} from "./credential-store.js";
import type { WorkerCredentialLookup } from "./fetch-worker.js";

/**
 * W2 — the OAuth half of the custody model (backend-ingest plan §6.1 branch **b1**, §6.2).
 *
 * DECISIONS `V-a-branch: b1` — unscoped OAuth. Fireflies publishes OAuth 2.0 (authorization code
 * + PKCE S256, refresh tokens, a revocation endpoint), but its only documented scopes are
 * `profile`/`email`: transcript access rides the grant and there is **no read-only scope**. So b1
 * buys custody, not data-scope — revocable, expiring, per-user — and the delete/reshare/re-role
 * blast radius is the thing the operator signed for separately. Nothing in this file can narrow
 * that; do not pretend otherwise in copy.
 *
 * Two rules this module exists to keep:
 *  1. **No token ever reaches a log or an error.** Provider error bodies are DISCARDED — a token
 *     endpoint that echoes the code or the refresh token would otherwise put it in a stack trace.
 *     Every failure is a fixed message plus the HTTP status.
 *  2. **The verifier stays server-side.** The PKCE verifier is minted here, held by the route's
 *     pending map, and used only in the exchange; it never rides a response.
 *
 * The endpoints are env-overridable because V-a is docs-grounded rather than live-tested: an
 * endpoint that turns out to differ must be a config change, not a code change.
 */

export interface FirefliesOAuthConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  revokeEndpoint: string;
  scope?: string;
}

export const DEFAULT_FIREFLIES_AUTHORIZE_ENDPOINT =
  "https://api.fireflies.ai/authorize";
export const DEFAULT_FIREFLIES_TOKEN_ENDPOINT = "https://api.fireflies.ai/token";
export const DEFAULT_FIREFLIES_REVOKE_ENDPOINT =
  "https://api.fireflies.ai/revoke";

/** Env → config. Throws when the operator armed the feature without registering an OAuth app. */
export function firefliesOAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FirefliesOAuthConfig {
  const clientId = (env.FIREFLIES_OAUTH_CLIENT_ID ?? "").trim();
  const redirectUri = (env.FIREFLIES_OAUTH_REDIRECT_URI ?? "").trim();
  if (clientId.length === 0 || redirectUri.length === 0) {
    throw new Error(
      "[startup] FATAL: FIREFLIES_OAUTH_CLIENT_ID and FIREFLIES_OAUTH_REDIRECT_URI are required " +
        "when CONNECTOR_BACKEND_INGEST_ENABLED=true",
    );
  }
  const clientSecret = (env.FIREFLIES_OAUTH_CLIENT_SECRET ?? "").trim();
  const scope = (env.FIREFLIES_OAUTH_SCOPE ?? "").trim();
  return {
    clientId,
    redirectUri,
    authorizeEndpoint:
      (env.FIREFLIES_OAUTH_AUTHORIZE_ENDPOINT ?? "").trim() ||
      DEFAULT_FIREFLIES_AUTHORIZE_ENDPOINT,
    tokenEndpoint:
      (env.FIREFLIES_OAUTH_TOKEN_ENDPOINT ?? "").trim() ||
      DEFAULT_FIREFLIES_TOKEN_ENDPOINT,
    revokeEndpoint:
      (env.FIREFLIES_OAUTH_REVOKE_ENDPOINT ?? "").trim() ||
      DEFAULT_FIREFLIES_REVOKE_ENDPOINT,
    ...(clientSecret.length === 0 ? {} : { clientSecret }),
    ...(scope.length === 0 ? {} : { scope }),
  };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** RFC 7636 S256. 32 random bytes → a 43-char unreserved verifier. Fresh per attempt. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** Everything the token endpoint may hand back, reduced to the fields we store. */
function toSecret(payload: unknown, now: number): OAuthCredentialSecret {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("oauth token response was not an object");
  }
  const value = payload as Record<string, unknown>;
  const accessToken = value.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // The body is NOT included: it is the one place a token would be.
    throw new Error("oauth token response carried no access token");
  }
  const secret: OAuthCredentialSecret = { kind: "oauth", accessToken };
  if (typeof value.refresh_token === "string") {
    secret.refreshToken = value.refresh_token;
  }
  if (typeof value.expires_in === "number" && Number.isFinite(value.expires_in)) {
    secret.expiresAt = new Date(now + value.expires_in * 1000).toISOString();
  }
  if (typeof value.scope === "string") secret.scope = value.scope;
  return secret;
}

export interface FirefliesOAuthClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class FirefliesOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: FirefliesOAuthConfig,
    options: FirefliesOAuthClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The authorization-code + PKCE S256 URL the user is sent to. */
  authorizeUrl(input: { state: string; challenge: string }): string {
    const url = new URL(this.config.authorizeEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (this.config.scope !== undefined) {
      url.searchParams.set("scope", this.config.scope);
    }
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    verifier: string;
  }): Promise<CredentialSecret> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.verifier,
    });
    if (this.config.clientSecret !== undefined) {
      body.set("client_secret", this.config.clientSecret);
    }
    return toSecret(await this.post(this.config.tokenEndpoint, body), this.now());
  }

  /** Refresh-token rotation (§6.2 "rotate: OAuth = refresh-token rotation (automatic)"). */
  async refresh(secret: CredentialSecret): Promise<CredentialSecret> {
    if (secret.kind !== "oauth" || secret.refreshToken === undefined) {
      throw new Error("credential is not refreshable");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: secret.refreshToken,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret !== undefined) {
      body.set("client_secret", this.config.clientSecret);
    }
    const rotated = toSecret(
      await this.post(this.config.tokenEndpoint, body),
      this.now(),
    );
    // Some providers omit the refresh token on a rotation; keeping the old one is the difference
    // between a working connector and one that silently stops refreshing tomorrow.
    if (rotated.refreshToken === undefined) {
      rotated.refreshToken = secret.refreshToken;
    }
    return rotated;
  }

  /** Upstream revocation. THROWS on failure — §6.2: surfaced, never swallowed. */
  async revoke(secret: CredentialSecret): Promise<void> {
    if (secret.kind !== "oauth") throw new Error("credential is not revocable");
    const body = new URLSearchParams({
      token: secret.refreshToken ?? secret.accessToken,
      token_type_hint: secret.refreshToken === undefined ? "access_token" : "refresh_token",
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret !== undefined) {
      body.set("client_secret", this.config.clientSecret);
    }
    await this.post(this.config.revokeEndpoint, body, { allowEmptyBody: true });
  }

  private async post(
    endpoint: string,
    body: URLSearchParams,
    options: { allowEmptyBody?: boolean } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch {
      // The thrown error can carry the request (and therefore the token) on its properties.
      throw new Error("oauth request failed");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Status only. An error BODY from a token endpoint is the last place a secret should be
      // read from and the first place it would be logged.
      throw new Error(`oauth request rejected (status ${response.status})`);
    }
    const text = await response.text();
    if (text.trim().length === 0) {
      if (options.allowEmptyBody === true) return {};
      throw new Error("oauth response was empty");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("oauth response was not JSON");
    }
  }
}

// ── Automatic rotation (§6.2 "rotate: OAuth = refresh-token rotation") ──

/** How long before expiry a credential is refreshed rather than used. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * The rotation the fetch worker calls before every use: read the stored credential, and if it
 * expires within the skew window, refresh it upstream and re-store it (which stamps `rotatedAt`
 * and REPLACES the old envelope — the previous token is not left readable in the substrate).
 *
 * Returns the credential to use, or null when the address has none. Fail closed: a refresh that
 * fails PROPAGATES, so the worker retries on its own backoff rather than using an expired token
 * and reading the 401 as "this user has no meetings".
 */
export async function refreshOAuthCredentialIfExpiring(input: {
  store: CredentialStore;
  client: { refresh(secret: CredentialSecret): Promise<CredentialSecret> };
  source: string;
  address: string;
  skewMs?: number;
  now?: () => number;
  /** §6.2 audit: the reason the credential was opened. The caller's purpose, not this helper's. */
  purpose?: CredentialAccessPurpose;
}): Promise<CredentialSecret | null> {
  const now = input.now ?? (() => Date.now());
  const skewMs = input.skewMs ?? DEFAULT_REFRESH_SKEW_MS;

  const current = await input.store.getCredential(
    input.source,
    input.address,
    input.purpose ?? "token-refresh",
  );
  if (current === null) return null;
  if (current.kind !== "oauth") return current;
  if (current.refreshToken === undefined || current.expiresAt === undefined) {
    return current;
  }

  const expiresAt = Date.parse(current.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - now() > skewMs) return current;

  const rotated = await input.client.refresh(current);
  await input.store.rotate({
    source: input.source,
    address: input.address,
    secret: rotated,
  });
  return rotated;
}

/**
 * The seam the process wires into W3: a {@link WorkerCredentialLookup} that ROTATES before it
 * returns. The worker asked for "the credential to use"; under branch b1 that is only ever the
 * refreshed one, because the access token expires as a matter of routine and a worker holding the
 * bare store would present an expired token, take a provider 401, gate the lane, and retry the
 * same dead token forever.
 *
 * `client` is a THUNK: `firefliesOAuthConfigFromEnv` throws on an unregistered OAuth app, and
 * building the client lazily keeps that failure on the path that needs it rather than at wiring
 * time. Fail closed: a refresh that fails propagates, and the worker holds the lane.
 */
export function createRefreshingCredentialLookup(input: {
  store: CredentialStore;
  client: () => { refresh(secret: CredentialSecret): Promise<CredentialSecret> };
  skewMs?: number;
  now?: () => number;
}): WorkerCredentialLookup {
  return {
    getCredential: (source, address, purpose) =>
      refreshOAuthCredentialIfExpiring({
        store: input.store,
        client: input.client(),
        source,
        address,
        // The audit line still says WHY the credential was opened: this is the worker's read.
        purpose,
        ...(input.skewMs !== undefined ? { skewMs: input.skewMs } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      }),
    markUsed: (source, address) => input.store.markUsed(source, address),
  };
}
