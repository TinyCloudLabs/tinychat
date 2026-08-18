import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import {
  GoogleOAuthClient,
  GoogleOAuthError,
  googleOAuthConfigFromEnv,
  type GoogleOAuthConfig,
  type GoogleOAuthPort,
} from "../services/google-oauth.js";

/**
 * WP-A — the Google Meet OAuth proxy routes (gmeet-connector plan §4.1, §6 WP-A).
 *
 * Intended mount: `/api/connectors/google/oauth/*`, wired by `index.ts` INSIDE the arming flag so
 * dark = no mount = 404. The split of middleware is the mount's job, not this file's (the house
 * router idiom — `connector-webhooks.ts`'s companion router takes none either):
 *
 *  - `GET /start` and `GET /callback` mount WITHOUT `authMiddleware`. The callback is a top-level
 *    browser navigation from Google and carries no Bearer; global CSRF exempts GET. The
 *    anti-forgery control is the `state` param, minted by and validated in the SPA.
 *  - `POST /exchange|/refresh|/revoke` mount BEHIND `authMiddleware` (global CSRF covers the
 *    unsafe methods automatically).
 *
 * Two invariants:
 *
 *  1. **Nothing persists.** No KV, no SQL, no file writes, no in-process credential cache — this
 *    module is a credential-shaped pipe between the SPA and Google. `google-oauth.test.ts` pins
 *    the absence of any store import structurally, because "we just won't store it" is exactly
 *    the kind of property that erodes by accident.
 *  2. **Only `{ code, state }` transits `postMessage`, to a PINNED origin.** Never `"*"`, never a
 *    token. The code alone is useless without the PKCE verifier, which never leaves SPA memory.
 */

/** Log shapes and statuses only — never a code, a verifier or a token. */
function logGoogleOAuth(fields: string): void {
  console.log(`[google-oauth] ${fields} t=${new Date().toISOString()}`);
}

// ── Param shape validation ───────────────────────────────────────────
//
// These are attacker-influenced query params on an UNAUTHENTICATED GET, and `/start` turns them
// into a 302 the browser follows. Shape checks run before anything else; an absurd length is a
// 400, never a redirect.

/** SPA-minted anti-forgery nonce: base64url/unreserved characters, bounded. */
const STATE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
/** RFC 7636: the S256 challenge is 43-128 unreserved characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** Google authorization codes carry `/` and `%`; only a length bound is defensible here. */
const MAX_CODE_LENGTH = 2048;
const MAX_VERIFIER_LENGTH = 128;
const MAX_TOKEN_LENGTH = 4096;

export function isValidOAuthState(value: unknown): value is string {
  return typeof value === "string" && STATE_PATTERN.test(value);
}

export function isValidPkceChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_PATTERN.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function firstQueryValue(value: unknown): unknown {
  // Express gives an ARRAY for a repeated param (`?state=a&state=b`); take neither, so a
  // duplicated param cannot smuggle a second value past a check that saw the first.
  return Array.isArray(value) ? undefined : value;
}

// ── The callback page ────────────────────────────────────────────────

/**
 * JSON, then HTML-neutralised. `JSON.stringify` alone is NOT enough inside a `<script>`: a `code`
 * containing `</script>` closes the block and everything after it becomes markup. The four
 * escapes below are the standard set — `<`/`>`/`&` so no tag or entity can form, and U+2028/2029
 * because they are literal line terminators in JS source but legal inside a JSON string.
 */
export function encodeForScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The tiny self-contained page Google's redirect lands on. It runs in the popup, hands
 * `{ code, state }` to the opener at the PINNED app origin, and closes itself.
 *
 * The nonce'd CSP is what makes the inline script both permitted and singular: `default-src
 * 'none'` means the page can load nothing, fetch nothing and frame nothing, and only the one
 * script carrying this response's nonce executes — so an escaping bug that did somehow inject
 * markup still could not run injected script.
 */
export function renderCallbackPage(input: {
  code: string;
  state: string;
  appOrigin: string;
  nonce: string;
}): string {
  const payload = `{"code":${encodeForScript(input.code)},"state":${encodeForScript(input.state)}}`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Google Meet connected</title></head>
<body>
<p>You can close this window.</p>
<script nonce="${input.nonce}">
(function () {
  var payload = ${payload};
  try {
    if (window.opener) window.opener.postMessage(payload, ${encodeForScript(input.appOrigin)});
  } catch (e) {}
  window.close();
})();
</script>
</body>
</html>
`;
}

/** The no-code page: a denial or a malformed return. It postMessages NOTHING. */
function renderCancelledPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Google Meet not connected</title></head>
<body>
<p>The Google Meet connection was not completed. You can close this window and try again.</p>
</body>
</html>
`;
}

/**
 * The app origin the callback page pins its `postMessage` to.
 *
 * SAME SOURCE as the CORS allowlist — `index.ts` builds its `cors({ origin: FRONTEND_URL })` from
 * `FRONTEND_URL` with a localhost fallback that depends on whether local TLS files are present.
 * Reusing that env (rather than adding a second origin field) is what keeps "the origin we accept
 * requests from" and "the origin we hand a code to" from drifting apart.
 */
export const APP_ORIGIN_ENV = "FRONTEND_URL";

export function googleAppOriginFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = (env[APP_ORIGIN_ENV] ?? "").trim();
  if (raw.length === 0) {
    throw new Error(
      `[startup] FATAL: ${APP_ORIGIN_ENV} is required when GOOGLE_MEET_OAUTH_ENABLED=true ` +
        "(it pins the OAuth callback postMessage target origin)",
    );
  }
  return normalizeAppOrigin(raw);
}

/**
 * `new URL(...).origin`, and it must be a real one. A wildcard, a bare host or anything that does
 * not parse THROWS here, at wiring time: a target origin that silently degraded to `"*"` is the
 * exact defect this pin exists to prevent.
 */
export function normalizeAppOrigin(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "*") {
    throw new Error("google oauth callback origin must not be \"*\"");
  }
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    throw new Error(`google oauth callback origin is not a valid URL: ${trimmed}`);
  }
  if (origin === "null" || origin.length === 0) {
    throw new Error(`google oauth callback origin is not a valid URL: ${trimmed}`);
  }
  return origin;
}

// ── Router ───────────────────────────────────────────────────────────

export interface GoogleOAuthRouterOptions {
  /** The upstream port. Defaults to a real client built from `config`. */
  oauth?: GoogleOAuthPort;
  /** Defaults to `googleOAuthConfigFromEnv()` — which throws when armed-but-unregistered. */
  config?: GoogleOAuthConfig;
  /** Defaults to `googleAppOriginFromEnv()`. Pinned target of the callback `postMessage`. */
  appOrigin?: string;
}

export function createGoogleOAuthRouter(
  options: GoogleOAuthRouterOptions = {},
): Router {
  const config = options.config ?? googleOAuthConfigFromEnv();
  const oauth = options.oauth ?? new GoogleOAuthClient(config);
  const appOrigin = normalizeAppOrigin(
    options.appOrigin ?? googleAppOriginFromEnv(),
  );

  const router = Router();

  /**
   * Helmet's app-wide default `Cross-Origin-Opener-Policy: same-origin` severs `window.opener`
   * for the popup the SPA opens: the `/start` 302 is the popup's first document-bearing response
   * and already carries the header, the browser swaps browsing-context groups, and the callback
   * page's `postMessage` can never reach the app (live-verified 2026-08-18 — the SPA reads the
   * silent close as "cancelled"). These routes exist to be a popup — the opener relationship IS
   * the feature — so they opt out; every other route keeps the helmet default.
   */
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    next();
  });

  /**
   * `GET /start?state=…&challenge=…` → 302 to Google.
   *
   * The SPA holds the verifier; the server only ever sees the challenge, so this route cannot
   * complete an exchange on its own and there is nothing here to persist.
   */
  router.get("/start", (req: Request, res: Response) => {
    const state = firstQueryValue(req.query.state);
    const challenge = firstQueryValue(req.query.challenge);
    if (!isValidOAuthState(state) || !isValidPkceChallenge(challenge)) {
      logGoogleOAuth("op=start result=invalid_request");
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    logGoogleOAuth("op=start result=redirect");
    // 302, and `Location` only — the params are already in the URL the client is sent to.
    res.redirect(302, oauth.authorizeUrl({ state, challenge }));
  });

  /**
   * `GET /callback?code=…&state=…` — the popup's landing page. Unauthenticated by necessity
   * (a top-level navigation from Google carries no Bearer) and harmless: it holds no session,
   * reads no store, and hands the code to exactly one origin.
   */
  router.get("/callback", (req: Request, res: Response) => {
    const code = firstQueryValue(req.query.code);
    const state = firstQueryValue(req.query.state);

    res.setHeader("Cache-Control", "no-store");
    // The `code` is in this page's URL — never let it ride a Referer to Google or anywhere else.
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (
      !isBoundedString(code, MAX_CODE_LENGTH) ||
      !isValidOAuthState(state)
    ) {
      // A denial (`?error=access_denied`) or a malformed return. NOTHING is postMessaged: the
      // SPA reads a popup that closed without a message as "cancelled", which is what happened.
      logGoogleOAuth("op=callback result=no_code");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.status(400).send(renderCancelledPage());
      return;
    }

    const nonce = randomBytes(16).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    logGoogleOAuth("op=callback result=posted");
    res.status(200).send(
      renderCallbackPage({ code, state, appOrigin, nonce }),
    );
  });

  /** `POST /exchange { code, verifier }` — authed at the mount. Returns Google's payload. */
  router.post("/exchange", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = body.code;
    const verifier = body.verifier;
    if (
      !isBoundedString(code, MAX_CODE_LENGTH) ||
      !isBoundedString(verifier, MAX_VERIFIER_LENGTH)
    ) {
      logGoogleOAuth("op=exchange result=invalid_request");
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const payload = await oauth.exchangeCode({ code, verifier });
      logGoogleOAuth(
        `op=exchange result=ok refresh_token=${payload.refresh_token === undefined ? "absent" : "present"}`,
      );
      res.status(200).json(payload);
    } catch (error) {
      respondUpstreamError(res, "exchange", error);
    }
  });

  /** `POST /refresh { refreshToken }` — the per-sync access-token mint. Persists nothing. */
  router.post("/refresh", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const refreshToken = body.refreshToken;
    if (!isBoundedString(refreshToken, MAX_TOKEN_LENGTH)) {
      logGoogleOAuth("op=refresh result=invalid_request");
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const payload = await oauth.refresh(refreshToken);
      logGoogleOAuth("op=refresh result=ok");
      res.status(200).json(payload);
    } catch (error) {
      respondUpstreamError(res, "refresh", error);
    }
  });

  /** `POST /revoke { token }` — upstream revocation. A failure is surfaced, never swallowed. */
  router.post("/revoke", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = body.token;
    if (!isBoundedString(token, MAX_TOKEN_LENGTH)) {
      logGoogleOAuth("op=revoke result=invalid_request");
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      await oauth.revoke(token);
      logGoogleOAuth("op=revoke result=ok");
      res.status(200).json({ status: "revoked" });
    } catch (error) {
      respondUpstreamError(res, "revoke", error);
    }
  });

  return router;
}

/**
 * Google's structured failure, forwarded rather than flattened (plan §6 WP-A — Listen discarded
 * it and could not tell reconnect from no-access from slow-down).
 *
 * A 4xx from Google is answered with the SAME status, so `invalid_grant` (400/401 ⇒ reconnect),
 * `PERMISSION_DENIED` (403 ⇒ not your meeting) and `slow_down` (429 ⇒ back off) each arrive at
 * the UI as themselves. Anything else — a Google 5xx, a timeout, an unparseable body — is a 502:
 * the proxy could not complete the call, and the client should retry rather than re-consent.
 */
function respondUpstreamError(
  res: Response,
  operation: string,
  error: unknown,
): void {
  if (res.headersSent) return;
  if (error instanceof GoogleOAuthError) {
    const status =
      error.status >= 400 && error.status < 500 ? error.status : 502;
    // Fields, not the message: the message is assembled from the same two fields anyway, and
    // this keeps the response shape stable for the SPA's error formatter.
    logGoogleOAuth(
      `op=${operation} result=upstream_error status=${error.status} error=${error.error}`,
    );
    res.status(status).json({
      error: error.error,
      ...(error.errorDescription === undefined
        ? {}
        : { error_description: error.errorDescription }),
      upstream_status: error.status,
    });
    return;
  }
  // Not a GoogleOAuthError: the cause is ours, and its message is not guaranteed token-free.
  logGoogleOAuth(`op=${operation} result=internal_error`);
  res.status(500).json({ error: "internal_error" });
}
