import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";

import {
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_CALENDAR_LINK_SCOPES,
  GOOGLE_MEET_SCOPES,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthClient,
  GoogleOAuthError,
  type GoogleOAuthConfig,
  type GoogleOAuthPort,
  type GoogleTokenPayload,
} from "../services/google-oauth.js";
import { createGoogleOAuthRouter } from "../routes/google-oauth.js";

/**
 * Calendar linking's OAuth purpose on a backend WITHOUT calendar autojoin wired: the consent it asks
 * Google for, and a revoke that has no server-held holder to protect. The grant guard with autojoin
 * wired is tested in calendar-autojoin-grants.test.ts. Every fixture is fake; nothing reaches a network.
 */

const TEST_CONFIG: GoogleOAuthConfig = {
  enabled: true,
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://api.example.test/api/connectors/google/oauth/callback",
  scope: GOOGLE_MEET_SCOPES,
  authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
};
const DESKTOP_CLIENT_ID = "desktop-client.apps.googleusercontent.com";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-0123456789abcdef";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const LINK_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned.readonly openid";

/** The real client builds every consent URL; only the calls that would reach Google are faked. */
class LinkOAuthPort implements GoogleOAuthPort {
  private readonly client = new GoogleOAuthClient(TEST_CONFIG);
  revokeCalls: string[] = [];
  revokeFailure: GoogleOAuthError | null = null;
  authorizeUrl(input: Parameters<GoogleOAuthPort["authorizeUrl"]>[0]): string { return this.client.authorizeUrl(input); }
  async exchangeCode(): Promise<GoogleTokenPayload> {
    return { access_token: "fake-link-access", refresh_token: "fake-link-refresh", expires_in: 3_600,
      scope: GOOGLE_CALENDAR_LINK_SCOPES, subject: "fake-google-subject" };
  }
  async refresh(): Promise<GoogleTokenPayload> { return { access_token: "fake-link-access" }; }
  async revoke(token: string): Promise<void> {
    this.revokeCalls.push(token);
    if (this.revokeFailure) throw this.revokeFailure;
  }
}

const port = new LinkOAuthPort();
const app = express();
app.use(express.json());
app.use("/oauth", createGoogleOAuthRouter({ oauth: port, config: TEST_CONFIG, appOrigin: "https://app.example.test",
  desktopClientId: DESKTOP_CLIENT_ID, nativeReturn: false }));
const server = app.listen(0);
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth`;
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { port.revokeCalls = []; port.revokeFailure = null; });

const post = (path: string, body: unknown) => fetch(`${base}/${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("calendar-link consent", () => {
  test("/start?purpose=calendar-link asks Google for the owned-events scope and openid only", async () => {
    const response = await fetch(`${base}/start?${new URLSearchParams({ state: STATE, challenge: CHALLENGE, purpose: "calendar-link" })}`,
      { redirect: "manual" });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location")!);
    expect(GOOGLE_CALENDAR_LINK_SCOPES).toBe(LINK_SCOPE);
    expect(url.searchParams.get("scope")).toBe(LINK_SCOPE);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(url.searchParams.has("nonce")).toBe(false);
    // Still a grant with a refresh token, bound to the SPA's state and PKCE challenge.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("client_id")).toBe(TEST_CONFIG.clientId);
  });

  test("/start without a purpose still asks for the Meet connector's scopes", async () => {
    const response = await fetch(`${base}/start?${new URLSearchParams({ state: STATE, challenge: CHALLENGE })}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const scope = new URL(response.headers.get("location")!).searchParams.get("scope")!;
    expect(scope).toBe(`${GOOGLE_MEET_SCOPES} openid`);
    expect(scope).not.toContain("calendar");
  });

  test("any other purpose, or a repeated one, is refused before Google is asked", async () => {
    for (const query of ["purpose=bogus", "purpose=autojoin", "purpose=", "purpose=calendar-link&purpose=calendar-link"]) {
      const response = await fetch(`${base}/start?state=${STATE}&challenge=${CHALLENGE}&${query}`, { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });

  test("/desktop/start carries the purpose to the Desktop client's consent URL", async () => {
    const redirectUri = "http://127.0.0.1:49152/oauth/google";
    const started = await fetch(`${base}/desktop/start?${new URLSearchParams({ state: STATE, challenge: CHALLENGE, redirectUri, purpose: "calendar-link" })}`);
    expect(started.status).toBe(200);
    const url = new URL((await started.json() as { authorizationUrl: string }).authorizationUrl);
    expect(url.searchParams.get("scope")).toBe(LINK_SCOPE);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe(DESKTOP_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    const refused = await fetch(`${base}/desktop/start?${new URLSearchParams({ state: STATE, challenge: CHALLENGE, redirectUri, purpose: "bogus" })}`);
    expect(refused.status).toBe(400);
  });
});

describe("calendar-link exchange and revoke without autojoin wired", () => {
  test("/exchange returns the browser token payload and no grant binding", async () => {
    const response = await post("exchange", { code: "fake-code", verifier: VERIFIER, purpose: "calendar-link" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access_token: "fake-link-access", refresh_token: "fake-link-refresh",
      expires_in: 3_600, scope: GOOGLE_CALENDAR_LINK_SCOPES });
  });

  test("/exchange and /revoke refuse any other purpose", async () => {
    for (const [path, body] of [["exchange", { code: "fake-code", verifier: VERIFIER, purpose: "bogus" }],
      ["revoke", { token: "fake-link-refresh", purpose: "autojoin" }]] as const) {
      const response = await post(path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(port.revokeCalls).toEqual([]);
  });

  test("/revoke needs a bounded token", async () => {
    for (const token of [undefined, "", "x".repeat(4097)]) {
      expect((await post("revoke", { purpose: "calendar-link", token })).status).toBe(400);
    }
    expect(port.revokeCalls).toEqual([]);
  });

  test("with no other holder on this server the token is revoked upstream once", async () => {
    const response = await post("revoke", { token: "fake-link-refresh", purpose: "calendar-link" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disconnected", upstreamRevoked: "ok", reason: "last_holder" });
    expect(port.revokeCalls).toEqual(["fake-link-refresh"]);
  });

  test("a connected Meet connector keeps the shared grant", async () => {
    const response = await post("revoke", { token: "fake-link-refresh", purpose: "calendar-link", connectorConnected: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disconnected", upstreamRevoked: "kept", reason: "connector_holder" });
    expect(port.revokeCalls).toEqual([]);
  });

  test("an upstream failure is a 502; a token Google no longer knows is already revoked", async () => {
    port.revokeFailure = new GoogleOAuthError({ status: 503, error: "server_error", operation: "revoke" });
    const failed = await post("revoke", { token: "fake-link-refresh", purpose: "calendar-link" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ status: "disconnected", upstreamRevoked: "failed", reason: "last_holder" });
    port.revokeFailure = new GoogleOAuthError({ status: 400, error: "invalid_token", operation: "revoke" });
    const gone = await post("revoke", { token: "fake-link-refresh", purpose: "calendar-link" });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ upstreamRevoked: "ok" });
  });

  test("a Meet disconnect while calendar linking is connected revokes nothing upstream", async () => {
    const response = await post("revoke", { token: "fake-meet-refresh", calendarLinkConnected: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disconnected", upstreamRevoked: "not_applicable" });
    expect(port.revokeCalls).toEqual([]);
  });
});
