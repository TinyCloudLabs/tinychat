/**
 * WP-A — the Google Meet OAuth client (gmeet-connector plan §4.1, §6 WP-A).
 *
 * `fireflies-oauth.ts` is the in-repo PKCE S256 precedent and this module mirrors its shape:
 * `authorizeUrl({state, challenge})`, `exchangeCode({code, verifier})`, `revoke`, and an
 * env→config that THROWS at boot when the feature is armed but the OAuth app is unregistered.
 * The deltas are Google's endpoints, the refresh grant, and two Google-specific authorize params.
 *
 * Three rules this module exists to keep:
 *
 *  1. **PERSISTS NOTHING.** It performs HTTP and returns payloads. No KV, no SQL, no files — the
 *     browser is the only place a Google token ever lands (plan §4.1: "tokens travel exclusively
 *     in the authenticated XHR response"). A store import here is a design regression, and
 *     `google-oauth.test.ts` pins the absence structurally.
 *  2. **No token ever reaches a log or an error.** Unlike `fireflies-oauth.ts`, which discards
 *     provider error bodies wholesale, this module PRESERVES Google's structured error
 *     (`status` + `error` + `error_description`) so the UI can tell reconnect from no-access from
 *     slow-down — Listen threw that away and could not. Preservation is field-scoped (only those
 *     two strings, capped and control-stripped) and every secret the request carried is redacted
 *     out of the surfaced text as a belt-and-braces second pass.
 *  3. **`access_type=offline` AND `prompt=consent`.** Spike-verified 2026-08-17: without BOTH,
 *     Google mints no refresh token and the connector silently becomes single-session. Neither
 *     param exists in the Fireflies template, so neither is inherited — they are set here.
 */

/** The authorize endpoint the popup is 302'd to. */
export const GOOGLE_AUTHORIZE_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
/** Both the authorization-code exchange and the refresh grant post here. */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Exactly the required scopes, space-separated, in this order (handoff §4).
 *
 * `meetings.space.readonly` reads conference records / transcripts; `meetings.space.settings`
 * carries the host-only auto-transcription toggle (S4, in scope per G1). The Drive metadata and
 * Docs scopes are used only to discover and parse Notes by Gemini meeting records.
 */
export const GOOGLE_MEET_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
].join(" ");

/** The arming flag. Mirrors `connectorWebhooksEnabled()` (index.ts :140-142) exactly. */
export const GOOGLE_MEET_OAUTH_ENABLED_ENV = "GOOGLE_MEET_OAUTH_ENABLED";

export function googleMeetOAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[GOOGLE_MEET_OAUTH_ENABLED_ENV] === "true";
}

export interface GoogleOAuthConfig {
  /** False ⇒ the mounts do not exist (dark default). The other fields are then empty strings. */
  enabled: boolean;
  clientId: string;
  /** Google requires the secret for a "Web application" client even WITH PKCE (spike-verified). */
  clientSecret: string;
  redirectUri: string;
  scope: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  revokeEndpoint: string;
}

const DISABLED_CONFIG: GoogleOAuthConfig = {
  enabled: false,
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  scope: GOOGLE_MEET_SCOPES,
  authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
};

/**
 * Env → config, with the `fireflies-oauth.ts:48-58` posture: armed-but-unregistered is a BOOT
 * failure, not a first-request failure. An operator who sets the flag and forgets a var learns it
 * from a refused start, never from a user's half-finished consent screen.
 *
 * Unarmed returns a disabled config WITHOUT throwing — the dark default must not depend on any
 * `GOOGLE_*` var existing at all.
 */
export function googleOAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleOAuthConfig {
  if (!googleMeetOAuthEnabled(env)) return { ...DISABLED_CONFIG };

  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = (env.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();

  const missing: string[] = [];
  if (clientId.length === 0) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (clientSecret.length === 0) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (redirectUri.length === 0) missing.push("GOOGLE_OAUTH_REDIRECT_URI");
  if (missing.length > 0) {
    // The NAMES only — a value here would be the client secret, in a fatal startup log.
    throw new Error(
      `[startup] FATAL: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        `required when ${GOOGLE_MEET_OAUTH_ENABLED_ENV}=true`,
    );
  }

  return {
    enabled: true,
    clientId,
    clientSecret,
    redirectUri,
    scope: GOOGLE_MEET_SCOPES,
    authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
  };
}

/**
 * The token-endpoint payload, field-whitelisted on the way out.
 *
 * Deliberately NOT a passthrough of Google's raw body: an `id_token` (a JWT carrying the user's
 * Google email, name and picture) rides along on some grants, and this connector has no business
 * handing that to the SPA. What the browser needs to sync is here and nothing else.
 */
export interface GoogleTokenPayload {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Google's structured failure, preserved (plan §6 WP-A). `status` + `error` are what the UI
 * branches on: `invalid_grant` ⇒ reconnect, `403`/`PERMISSION_DENIED` ⇒ not-your-meeting,
 * `slow_down`/429 ⇒ back off. `error_description` is the human line.
 *
 * The message is assembled from those fields ONLY, then re-scrubbed of every secret the request
 * carried, so no code path can turn a chatty upstream body into a token in a stack trace.
 */
export class GoogleOAuthError extends Error {
  /** HTTP status, or 0 when the request never completed (network/timeout/abort). */
  readonly status: number;
  /** Google's `error` code, or a local sentinel (`network_error`, `invalid_response`). */
  readonly error: string;
  readonly errorDescription: string | undefined;

  constructor(input: {
    status: number;
    error: string;
    errorDescription?: string | undefined;
    operation: string;
  }) {
    const description =
      input.errorDescription === undefined || input.errorDescription.length === 0
        ? ""
        : `: ${input.errorDescription}`;
    super(
      `google oauth ${input.operation} failed (status ${input.status}, ${input.error})${description}`,
    );
    this.name = "GoogleOAuthError";
    this.status = input.status;
    this.error = input.error;
    this.errorDescription = input.errorDescription;
  }
}

/** Upstream strings are bounded and control-stripped before they can reach a log line. */
const MAX_ERROR_FIELD_LENGTH = 200;

function safeErrorField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters (CR/LF especially) would forge lines into the CVM's public log stream.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_ERROR_FIELD_LENGTH);
}

/**
 * Second pass: any secret this request carried is removed from text that came back. Google does
 * not echo credentials today; this makes "does not" independent of Google's future behaviour.
 */
function redactSecrets(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    while (out.includes(secret)) out = out.replace(secret, "[redacted]");
  }
  return out;
}

export interface GoogleOAuthClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The port the router talks to — the seam tests substitute. */
export interface GoogleOAuthPort {
  authorizeUrl(input: { state: string; challenge: string }): string;
  exchangeCode(input: {
    code: string;
    verifier: string;
  }): Promise<GoogleTokenPayload>;
  refresh(refreshToken: string): Promise<GoogleTokenPayload>;
  revoke(token: string): Promise<void>;
}

export class GoogleOAuthClient implements GoogleOAuthPort {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: GoogleOAuthConfig,
    options: GoogleOAuthClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The consent URL the popup is sent to.
   *
   * `access_type=offline` + `prompt=consent` are NON-OPTIONAL and non-inherited: verified live on
   * 2026-08-17 that dropping either yields a grant with no `refresh_token`, which turns every
   * later session into a silent re-consent. `prompt=consent` also means a re-connect always
   * re-issues the refresh token rather than returning an access token the SPA cannot renew.
   */
  authorizeUrl(input: { state: string; challenge: string }): string {
    const url = new URL(this.config.authorizeEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scope);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  /**
   * Authorization-code exchange. Google's "Web application" client type wants the PKCE verifier
   * AND the client secret together (spike-verified) — PKCE alone is rejected `invalid_client`,
   * and the secret alone would drop the proof-of-possession the popup flow depends on.
   */
  async exchangeCode(input: {
    code: string;
    verifier: string;
  }): Promise<GoogleTokenPayload> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
    });
    const payload = await this.post("exchange", this.config.tokenEndpoint, body, [
      input.code,
      input.verifier,
      this.config.clientSecret,
    ]);
    return toTokenPayload(payload, "exchange");
  }

  /**
   * The refresh grant — the half `fireflies-oauth.ts` shapes differently, because there the
   * server holds the credential and rotates it in a store. Here the browser holds the refresh
   * token and hands it in per sync; nothing is written on this side of the call.
   *
   * Google usually omits `refresh_token` on a rotation, so the caller keeps the one it sent.
   */
  async refresh(refreshToken: string): Promise<GoogleTokenPayload> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const payload = await this.post("refresh", this.config.tokenEndpoint, body, [
      refreshToken,
      this.config.clientSecret,
    ]);
    return toTokenPayload(payload, "refresh");
  }

  /** Upstream revocation. THROWS on failure — a swallowed revoke is a lie to the user. */
  async revoke(token: string): Promise<void> {
    const body = new URLSearchParams({ token });
    await this.post("revoke", this.config.revokeEndpoint, body, [token], {
      allowEmptyBody: true,
    });
  }

  private async post(
    operation: string,
    endpoint: string,
    body: URLSearchParams,
    secrets: readonly string[],
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
      // The caught error can carry the whole request (and therefore the token) on its
      // properties, so it is dropped rather than wrapped.
      throw new GoogleOAuthError({
        status: 0,
        error: "network_error",
        operation,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    const parsed = parseJsonObject(text);

    if (!response.ok) {
      const error =
        safeErrorField(parsed?.error) ??
        safeErrorField((parsed?.error as { status?: unknown } | undefined)?.status) ??
        "oauth_error";
      const description =
        safeErrorField(parsed?.error_description) ??
        safeErrorField((parsed?.error as { message?: unknown } | undefined)?.message);
      throw new GoogleOAuthError({
        status: response.status,
        error: redactSecrets(error, secrets),
        errorDescription:
          description === undefined
            ? undefined
            : redactSecrets(description, secrets),
        operation,
      });
    }

    if (text.trim().length === 0) {
      if (options.allowEmptyBody === true) return {};
      throw new GoogleOAuthError({
        status: response.status,
        error: "invalid_response",
        errorDescription: "empty body",
        operation,
      });
    }
    if (parsed === null) {
      // The BODY is not included: on a token endpoint it is the one place a secret lives.
      throw new GoogleOAuthError({
        status: response.status,
        error: "invalid_response",
        errorDescription: "body was not a JSON object",
        operation,
      });
    }
    return parsed;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whitelist the fields the browser needs. `id_token` and anything unknown are dropped. */
function toTokenPayload(raw: unknown, operation: string): GoogleTokenPayload {
  const value = raw as Record<string, unknown>;
  const accessToken = value?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GoogleOAuthError({
      status: 200,
      error: "invalid_response",
      errorDescription: "no access token in token response",
      operation,
    });
  }
  const payload: GoogleTokenPayload = { access_token: accessToken };
  if (typeof value.token_type === "string") payload.token_type = value.token_type;
  if (typeof value.expires_in === "number" && Number.isFinite(value.expires_in)) {
    payload.expires_in = value.expires_in;
  }
  if (typeof value.refresh_token === "string" && value.refresh_token.length > 0) {
    payload.refresh_token = value.refresh_token;
  }
  if (typeof value.scope === "string") payload.scope = value.scope;
  return payload;
}
