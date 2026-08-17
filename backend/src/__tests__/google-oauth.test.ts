import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AddressInfo } from "node:net";

import {
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_MEET_SCOPES,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthClient,
  GoogleOAuthError,
  googleMeetOAuthEnabled,
  googleOAuthConfigFromEnv,
  type GoogleOAuthConfig,
  type GoogleOAuthPort,
  type GoogleTokenPayload,
} from "../services/google-oauth.js";
import {
  createGoogleOAuthRouter,
  encodeForScript,
  isValidOAuthState,
  isValidPkceChallenge,
  normalizeAppOrigin,
} from "../routes/google-oauth.js";

/**
 * WP-A tests (gmeet-connector plan §8): the OAuth client's Google-specific parameters, the
 * env-config's armed-but-unregistered boot failure, the route shapes, and the two structural pins
 * the design leans on — the callback page's target-origin pinning and NO PERSISTENCE.
 *
 * Every fixture below is obviously fake. No real client id, no real secret, and no network: the
 * client takes an injected `fetchImpl` and the router takes an injected port.
 */

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://api.example.test/api/connectors/google/oauth/callback";
const APP_ORIGIN = "https://app.example.test";

const TEST_CONFIG: GoogleOAuthConfig = {
  enabled: true,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
  scope: GOOGLE_MEET_SCOPES,
  authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
};

/** 43 chars — a real S256 challenge width. */
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-0123456789abcdef";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
  body: URLSearchParams;
}

/** A `fetch` stand-in that records the form body and replies with a canned response. */
function recordingFetch(
  reply: () => Response,
): { impl: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      init,
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    return reply();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── authorizeUrl ─────────────────────────────────────────────────────

describe("authorizeUrl", () => {
  const client = new GoogleOAuthClient(TEST_CONFIG);
  const url = new URL(client.authorizeUrl({ state: STATE, challenge: CHALLENGE }));

  test("targets Google's authorize endpoint with response_type=code", () => {
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  test("carries PKCE S256", () => {
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("requests EXACTLY the two Meet scopes and nothing else", () => {
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toBe(
      "https://www.googleapis.com/auth/meetings.space.readonly " +
        "https://www.googleapis.com/auth/meetings.space.settings",
    );
    expect(scope.split(" ")).toHaveLength(2);
    // A Drive or Calendar scope here is a compliance change, not a code change.
    expect(scope).not.toContain("drive");
    expect(scope).not.toContain("calendar");
  });

  test("carries access_type=offline AND prompt=consent (no refresh token without BOTH)", () => {
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("uses the configured redirect_uri and passes state through", () => {
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe(STATE);
  });
});

// ── exchangeCode / refresh / revoke ──────────────────────────────────

describe("exchangeCode", () => {
  test("posts code_verifier AND client_secret to Google's token endpoint", async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        access_token: "fake-access-token",
        refresh_token: "fake-refresh-token",
        expires_in: 3599,
        token_type: "Bearer",
        scope: GOOGLE_MEET_SCOPES,
      }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const payload = await client.exchangeCode({
      code: "fake-auth-code",
      verifier: VERIFIER,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    const body = calls[0]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("fake-auth-code");
    expect(body.get("code_verifier")).toBe(VERIFIER);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);

    expect(payload.access_token).toBe("fake-access-token");
    expect(payload.refresh_token).toBe("fake-refresh-token");
    expect(payload.expires_in).toBe(3599);
  });

  test("drops fields the browser has no business receiving (id_token)", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(200, {
        access_token: "fake-access-token",
        id_token: "fake.id.token",
      }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const payload = await client.exchangeCode({
      code: "fake-auth-code",
      verifier: VERIFIER,
    });
    expect(Object.keys(payload)).toEqual(["access_token"]);
  });
});

describe("refresh", () => {
  test("uses grant_type=refresh_token with client id + secret", async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse(200, { access_token: "fresh-access-token", expires_in: 3599 }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const payload = await client.refresh("fake-refresh-token");

    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    const body = calls[0]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("fake-refresh-token");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(body.get("code_verifier")).toBeNull();
    expect(payload.access_token).toBe("fresh-access-token");
  });
});

describe("revoke", () => {
  test("posts the token to Google's revoke endpoint and tolerates an empty body", async () => {
    const { impl, calls } = recordingFetch(() => new Response("", { status: 200 }));
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    await client.revoke("fake-refresh-token");
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(calls[0]?.body.get("token")).toBe("fake-refresh-token");
  });
});

// ── Structured error preservation ────────────────────────────────────

describe("google error preservation", () => {
  test("a 4xx surfaces status + error code + description", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });

    let thrown: unknown;
    try {
      await client.refresh("fake-refresh-token");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GoogleOAuthError);
    const error = thrown as GoogleOAuthError;
    expect(error.status).toBe(400);
    expect(error.error).toBe("invalid_grant");
    expect(error.errorDescription).toBe("Token has been expired or revoked.");
    // The distinction the UI branches on survives — and no token rides along.
    expect(error.message).not.toContain("fake-refresh-token");
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  test("a 429 slow_down keeps its status so the caller can back off", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(429, { error: "slow_down", error_description: "Rate limited" }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const error = (await client
      .refresh("fake-refresh-token")
      .catch((e: unknown) => e)) as GoogleOAuthError;
    expect(error.status).toBe(429);
    expect(error.error).toBe("slow_down");
  });

  test("an error body that echoes the request's secrets is redacted", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(400, {
        error: "invalid_request",
        error_description: `rejected code fake-auth-code with secret ${CLIENT_SECRET}`,
      }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const error = (await client
      .exchangeCode({ code: "fake-auth-code", verifier: VERIFIER })
      .catch((e: unknown) => e)) as GoogleOAuthError;

    expect(error.status).toBe(400);
    expect(error.error).toBe("invalid_request");
    expect(error.errorDescription).not.toContain(CLIENT_SECRET);
    expect(error.errorDescription).not.toContain("fake-auth-code");
    expect(error.errorDescription).toContain("[redacted]");
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  test("a network failure is status 0 / network_error and carries no request detail", async () => {
    const impl = (async () => {
      throw new Error(`connect failed for token fake-refresh-token`);
    }) as unknown as typeof fetch;
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const error = (await client
      .refresh("fake-refresh-token")
      .catch((e: unknown) => e)) as GoogleOAuthError;
    expect(error.status).toBe(0);
    expect(error.error).toBe("network_error");
    expect(error.message).not.toContain("fake-refresh-token");
  });

  test("a 200 with no access token is an invalid_response, body not echoed", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(200, { unexpected: "fake-refresh-token" }),
    );
    const client = new GoogleOAuthClient(TEST_CONFIG, { fetchImpl: impl });
    const error = (await client
      .refresh("fake-refresh-token")
      .catch((e: unknown) => e)) as GoogleOAuthError;
    expect(error.error).toBe("invalid_response");
    expect(error.message).not.toContain("fake-refresh-token");
  });
});

// ── googleOAuthConfigFromEnv ─────────────────────────────────────────

describe("googleOAuthConfigFromEnv", () => {
  const ARMED = {
    GOOGLE_MEET_OAUTH_ENABLED: "true",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
  } as unknown as NodeJS.ProcessEnv;

  test("unarmed returns a disabled config WITHOUT throwing, even with nothing else set", () => {
    const config = googleOAuthConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.clientId).toBe("");
    expect(config.clientSecret).toBe("");
    expect(googleMeetOAuthEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("the flag is exact-match 'true' (a stray value does not arm)", () => {
    expect(
      googleMeetOAuthEnabled({
        GOOGLE_MEET_OAUTH_ENABLED: "1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(googleOAuthConfigFromEnv({
      GOOGLE_MEET_OAUTH_ENABLED: "yes",
    } as unknown as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  test("armed + complete returns an enabled config with the pinned endpoints", () => {
    const config = googleOAuthConfigFromEnv(ARMED);
    expect(config.enabled).toBe(true);
    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.redirectUri).toBe(REDIRECT_URI);
    expect(config.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
    expect(config.revokeEndpoint).toBe("https://oauth2.googleapis.com/revoke");
    expect(config.scope).toBe(GOOGLE_MEET_SCOPES);
  });

  for (const missing of [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
  ]) {
    test(`armed but missing ${missing} THROWS at boot`, () => {
      const env = { ...ARMED } as Record<string, string>;
      delete env[missing];
      expect(() =>
        googleOAuthConfigFromEnv(env as unknown as NodeJS.ProcessEnv),
      ).toThrow(missing);
    });

    test(`armed with an empty ${missing} THROWS at boot`, () => {
      const env = { ...ARMED, [missing]: "   " } as unknown as NodeJS.ProcessEnv;
      expect(() => googleOAuthConfigFromEnv(env)).toThrow(missing);
    });
  }

  test("the boot failure names the vars, never their values", () => {
    const env = { ...ARMED } as Record<string, string>;
    delete env.GOOGLE_OAUTH_CLIENT_SECRET;
    let message = "";
    try {
      googleOAuthConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(message).not.toContain(CLIENT_ID);
    expect(message).not.toContain(REDIRECT_URI);
  });
});

// ── Param validators + script encoding ───────────────────────────────

describe("param shape validation", () => {
  test("state must be bounded unreserved characters", () => {
    expect(isValidOAuthState(STATE)).toBe(true);
    expect(isValidOAuthState("")).toBe(false);
    expect(isValidOAuthState("short")).toBe(false);
    expect(isValidOAuthState("a".repeat(513))).toBe(false);
    expect(isValidOAuthState("state with spaces!!!!!!!")).toBe(false);
    expect(isValidOAuthState(undefined)).toBe(false);
  });

  test("the PKCE challenge must be RFC 7636 shaped", () => {
    expect(isValidPkceChallenge(CHALLENGE)).toBe(true);
    expect(isValidPkceChallenge("too-short")).toBe(false);
    expect(isValidPkceChallenge("a".repeat(129))).toBe(false);
    expect(isValidPkceChallenge(`${CHALLENGE.slice(0, 42)}/`)).toBe(false);
  });
});

describe("encodeForScript", () => {
  test("neutralises a </script> breakout", () => {
    const encoded = encodeForScript("</script><img src=x onerror=alert(1)>");
    expect(encoded).not.toContain("</script>");
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain(">");
    // Still a faithful JS string literal: it parses back to the original.
    expect(JSON.parse(encoded)).toBe("</script><img src=x onerror=alert(1)>");
  });

  test("escapes the JS line terminators JSON permits raw", () => {
    const encoded = encodeForScript("a\u2028b\u2029c");
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");
    expect(JSON.parse(encoded)).toBe("a\u2028b\u2029c");
  });
});

describe("normalizeAppOrigin", () => {
  test("reduces a URL to its origin", () => {
    expect(normalizeAppOrigin("https://app.example.test/chat?x=1")).toBe(
      "https://app.example.test",
    );
  });

  test("refuses a wildcard and anything that is not a URL", () => {
    expect(() => normalizeAppOrigin("*")).toThrow();
    expect(() => normalizeAppOrigin("app.example.test")).toThrow();
    expect(() => normalizeAppOrigin("")).toThrow();
  });
});

// ── Routes ───────────────────────────────────────────────────────────

class FakeOAuthPort implements GoogleOAuthPort {
  authorizeCalls: Array<{ state: string; challenge: string }> = [];
  exchangeCalls: Array<{ code: string; verifier: string }> = [];
  refreshCalls: string[] = [];
  revokeCalls: string[] = [];
  failWith: unknown = null;

  authorizeUrl(input: { state: string; challenge: string }): string {
    this.authorizeCalls.push(input);
    return new GoogleOAuthClient(TEST_CONFIG).authorizeUrl(input);
  }

  async exchangeCode(input: {
    code: string;
    verifier: string;
  }): Promise<GoogleTokenPayload> {
    this.exchangeCalls.push(input);
    if (this.failWith !== null) throw this.failWith;
    return { access_token: "fake-access-token", refresh_token: "fake-refresh-token" };
  }

  async refresh(refreshToken: string): Promise<GoogleTokenPayload> {
    this.refreshCalls.push(refreshToken);
    if (this.failWith !== null) throw this.failWith;
    return { access_token: "fake-access-token", expires_in: 3599 };
  }

  async revoke(token: string): Promise<void> {
    this.revokeCalls.push(token);
    if (this.failWith !== null) throw this.failWith;
  }
}

let port: FakeOAuthPort;
let server: ReturnType<express.Express["listen"]>;
let base: string;

beforeEach(async () => {
  port = new FakeOAuthPort();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/connectors/google/oauth",
    createGoogleOAuthRouter({
      oauth: port,
      config: TEST_CONFIG,
      appOrigin: APP_ORIGIN,
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors/google/oauth`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /start", () => {
  test("302s to Google with the minted params", async () => {
    const response = await fetch(
      `${base}/start?state=${STATE}&challenge=${CHALLENGE}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.host).toBe("accounts.google.com");
    expect(location.searchParams.get("state")).toBe(STATE);
    expect(location.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
  });

  for (const [label, query] of [
    ["missing both", ""],
    ["missing challenge", `?state=${STATE}`],
    ["missing state", `?challenge=${CHALLENGE}`],
    ["short state", `?state=abc&challenge=${CHALLENGE}`],
    ["absurd state", `?state=${"a".repeat(4096)}&challenge=${CHALLENGE}`],
    ["absurd challenge", `?state=${STATE}&challenge=${"a".repeat(4096)}`],
    ["challenge with a bad character", `?state=${STATE}&challenge=${"a".repeat(42)}%2F`],
    ["repeated state", `?state=${STATE}&state=${STATE}&challenge=${CHALLENGE}`],
  ] as const) {
    test(`rejects malformed params with 400 (${label})`, async () => {
      const response = await fetch(`${base}/start${query}`, {
        redirect: "manual",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toEqual({ error: "invalid_request" });
    });
  }
});

describe("GET /callback", () => {
  test("returns a postMessage page pinned to the configured origin", async () => {
    const response = await fetch(
      `${base}/callback?code=fake-auth-code&state=${STATE}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();

    expect(html).toContain("window.opener.postMessage");
    // The exact configured origin literal appears...
    expect(html).toContain(`"${APP_ORIGIN}"`);
    // ...and the wildcard target NEVER does, in any form.
    expect(html).not.toContain("*");
    expect(html).toContain("window.close()");
    expect(html).toContain("fake-auth-code");
    expect(html).toContain(STATE);
  });

  test("transits ONLY { code, state } — no token material", async () => {
    const html = await (
      await fetch(`${base}/callback?code=fake-auth-code&state=${STATE}`)
    ).text();
    const payload = html.match(/var payload = (\{.*?\});/)?.[1] ?? "";
    expect(JSON.parse(payload)).toEqual({
      code: "fake-auth-code",
      state: STATE,
    });
    expect(html).not.toContain("access_token");
    expect(html).not.toContain("refresh_token");
    expect(html).not.toContain(CLIENT_SECRET);
  });

  test("a code containing </script> cannot break out of the script block", async () => {
    const hostile = "</script><script>window.evil=1</script>";
    const html = await (
      await fetch(
        `${base}/callback?code=${encodeURIComponent(hostile)}&state=${STATE}`,
      )
    ).text();

    // Exactly ONE script element, and it is ours: the injected markup survives only as an inert
    // JS string literal (`window.evil` is present as text, and can never be present as code).
    expect(html.split("<script")).toHaveLength(2);
    expect(html.split("</script>")).toHaveLength(2);
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain("<script>window.evil");
    const payload = html.match(/var payload = (\{.*?\});/)?.[1] ?? "";
    expect(JSON.parse(payload).code).toBe(hostile);
    // Nothing attacker-supplied reaches the document as markup: the only `<`/`>` in the page
    // belong to the static template, never to the interpolated payload.
    expect(payload).not.toContain("<");
    expect(payload).not.toContain(">");
  });

  test("a hostile state is encoded the same way", async () => {
    // Shape validation rejects it long before encoding — belt and braces on both.
    const response = await fetch(
      `${base}/callback?code=fake-auth-code&state=${encodeURIComponent("</script>")}`,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain("postMessage");
    expect(html.split("</script>")).toHaveLength(1);
  });

  test("carries a locked-down CSP, no-store and no-referrer", async () => {
    const response = await fetch(
      `${base}/callback?code=fake-auth-code&state=${STATE}`,
    );
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("a denial (no code) postMessages nothing", async () => {
    const response = await fetch(
      `${base}/callback?error=access_denied&state=${STATE}`,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain("postMessage");
    expect(html).not.toContain(APP_ORIGIN);
  });
});

describe("POST /exchange", () => {
  test("passes { code, verifier } through and returns Google's payload", async () => {
    const response = await fetch(`${base}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "fake-auth-code", verifier: VERIFIER }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "fake-access-token",
      refresh_token: "fake-refresh-token",
    });
    expect(port.exchangeCalls).toEqual([
      { code: "fake-auth-code", verifier: VERIFIER },
    ]);
  });

  for (const [label, body] of [
    ["no verifier", { code: "fake-auth-code" }],
    ["no code", { verifier: VERIFIER }],
    ["empty code", { code: "", verifier: VERIFIER }],
    ["non-string verifier", { code: "fake-auth-code", verifier: 7 }],
  ] as const) {
    test(`400s on a malformed body (${label})`, async () => {
      const response = await fetch(`${base}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
      expect(port.exchangeCalls).toHaveLength(0);
    });
  }

  test("forwards Google's structured 4xx with its status", async () => {
    port.failWith = new GoogleOAuthError({
      status: 400,
      error: "invalid_grant",
      errorDescription: "Bad Request",
      operation: "exchange",
    });
    const response = await fetch(`${base}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "fake-auth-code", verifier: VERIFIER }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "Bad Request",
      upstream_status: 400,
    });
  });

  test("a Google 5xx becomes a 502 (retry, not re-consent)", async () => {
    port.failWith = new GoogleOAuthError({
      status: 503,
      error: "backend_error",
      operation: "exchange",
    });
    const response = await fetch(`${base}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "fake-auth-code", verifier: VERIFIER }),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).upstream_status).toBe(503);
  });

  test("a non-Google throw becomes a bare 500 with no detail", async () => {
    port.failWith = new Error("internal detail with fake-auth-code inside");
    const response = await fetch(`${base}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "fake-auth-code", verifier: VERIFIER }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});

describe("POST /refresh", () => {
  test("passes the refresh token through and returns the access-token payload", async () => {
    const response = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "fake-refresh-token" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "fake-access-token",
      expires_in: 3599,
    });
    expect(port.refreshCalls).toEqual(["fake-refresh-token"]);
  });

  test("400s without a refresh token", async () => {
    const response = await fetch(`${base}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(port.refreshCalls).toHaveLength(0);
  });
});

describe("POST /revoke", () => {
  test("revokes upstream and reports the outcome", async () => {
    const response = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fake-refresh-token" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "revoked" });
    expect(port.revokeCalls).toEqual(["fake-refresh-token"]);
  });

  test("an upstream revoke failure is surfaced, never swallowed", async () => {
    port.failWith = new GoogleOAuthError({
      status: 400,
      error: "invalid_token",
      operation: "revoke",
    });
    const response = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "fake-refresh-token" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_token");
  });
});

// ── Structural pins ──────────────────────────────────────────────────

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function importSpecifiers(relativePath: string): string[] {
  const text = readFileSync(join(SRC_DIR, relativePath), "utf8");
  return [...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("no persistence", () => {
  /**
   * The plan's load-bearing property: the OAuth proxy PERSISTS NOTHING (§4.1 — "no KV, no SQL,
   * no token material in logs"). An import allowlist is the cheapest durable statement of that:
   * a store, a queue, the node SDK or `node:fs` appearing here is the regression itself.
   */
  for (const file of [
    "services/google-oauth.ts",
    "routes/google-oauth.ts",
  ]) {
    test(`${file} imports no store, queue, SDK or filesystem module`, () => {
      const specifiers = importSpecifiers(file);
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(
          /store|queue|kv|sql|node-sdk|tinycloud|tinyboilerplate|node:fs|content|credential|delegation/i,
        );
      }
    });
  }

  test("the allowlist is exactly what these two modules may import", () => {
    expect(importSpecifiers("services/google-oauth.ts")).toEqual([]);
    expect(new Set(importSpecifiers("routes/google-oauth.ts"))).toEqual(
      new Set(["node:crypto", "express", "../services/google-oauth.js"]),
    );
  });

  test("neither module logs token material", () => {
    for (const file of ["services/google-oauth.ts", "routes/google-oauth.ts"]) {
      const text = readFileSync(join(SRC_DIR, file), "utf8");
      const logLines = text
        .split("\n")
        .filter((line) => /console\.(log|warn|error|info)/.test(line));
      for (const line of logLines) {
        expect(line).not.toMatch(/access_token|refresh_token|\bcode\b|verifier|secret/);
      }
    }
  });

  test("no real credential material is committed in these modules or this test", () => {
    // Assembled, never written out: a literal here would put the very pattern it forbids into
    // the file it scans (and would defeat any secret scanner reading this repo).
    const secretPrefix = ["GOC", "SPX", "-"].join("");
    const realClientNumber = [961, 979, 276, 866].join("");
    for (const file of [
      "services/google-oauth.ts",
      "routes/google-oauth.ts",
      "__tests__/google-oauth.test.ts",
    ]) {
      const text = readFileSync(join(SRC_DIR, file), "utf8");
      expect(text).not.toContain(secretPrefix);
      expect(text).not.toContain(realClientNumber);
    }
  });
});

afterAll(() => {
  // Nothing to tear down: this suite created no store, no node client and no temp file.
});
