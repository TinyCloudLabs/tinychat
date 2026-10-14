import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createGoogleOAuthRouter } from "../routes/google-oauth.js";
import { CalendarAutojoinConnection, GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE } from "../services/calendar-autojoin-connection.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator } from "../services/calendar-autojoin-store.js";
import { CredentialStore, InMemoryCredentialRowStore } from "../services/credential-store.js";
import { GOOGLE_AUTOJOIN_SCOPES, GOOGLE_MEET_SCOPES, GoogleOAuthClient, type GoogleOAuthConfig } from "../services/google-oauth.js";

// Signed fixtures, local certificate responses and loopback HTTP only. No Google network access.
const WEB = "synthetic-web.apps.googleusercontent.com";
const DESKTOP = "synthetic-desktop.apps.googleusercontent.com";
const TENANT = "0x7d033300000000000000000000000000000073f2";
const SUBJECT = "12345";
const VERIFIER = "a".repeat(43);
const NONCE = "synthetic-bound-nonce";
const MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const DESKTOP_RETURN = "http://127.0.0.1:49152/oauth/google";
const CONFIG: GoogleOAuthConfig = {
  enabled: true, clientId: WEB, clientSecret: "synthetic-client-secret",
  redirectUri: "https://api.example.test/oauth/callback", scope: GOOGLE_MEET_SCOPES,
  authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token", revokeEndpoint: "https://oauth2.googleapis.com/revoke",
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-identity-key", alg: "RS256", use: "sig" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
type Failure = "signature" | "audience" | "expiry" | "issuer" | "numeric_subject" | "empty_subject"
  | "presenter" | "empty_presenter" | "null_presenter" | "certificate_fetch" | "malformed_token";

function upstream(clientId: string, failure?: Failure, extraClaims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: failure === "issuer" ? "https://untrusted.example.test" : "https://accounts.google.com",
    aud: failure === "audience" ? "unrelated-client" : clientId,
    iat: now - 3_600, exp: failure === "expiry" ? now - 600 : now + 3_600,
    sub: failure === "numeric_subject" ? Number(SUBJECT) : failure === "empty_subject" ? "" : SUBJECT,
    azp: failure === "presenter" ? clientId === WEB ? DESKTOP : WEB
      : failure === "empty_presenter" ? "" : failure === "null_presenter" ? null : clientId,
    nonce: NONCE, email_verified: true, email: "synthetic-identity@example.test",
    ...extraClaims,
  };
  const body = `${encode({ alg: "RS256", kid: "synthetic-identity-key" })}.${encode(claims)}`;
  const signature = sign("RSA-SHA256", Buffer.from(body), privateKey);
  if (failure === "signature") signature[0] = signature[0]! ^ 255;
  const idToken = failure === "malformed_token" ? "synthetic-malformed-token" : `${body}.${signature.toString("base64url")}`;
  const exchanges: URLSearchParams[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CONFIG.tokenEndpoint) {
      exchanges.push(new URLSearchParams(init?.body as URLSearchParams));
      return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", scope: GOOGLE_AUTOJOIN_SCOPES, id_token: idToken });
    }
    if (url.includes("/certs")) {
      if (failure === "certificate_fetch") return Response.json({ error: "synthetic-certificate-failure" }, { status: 400 });
      return url.includes("/v3/certs") ? Response.json({ keys: [publicJwk] }) : Response.json({ "synthetic-identity-key": publicPem });
    }
    throw new Error("Synthetic network guard: unexpected OAuth endpoint");
  }) as typeof fetch;
  return { fetchImpl, exchanges, idToken };
}

async function enabledConnection() {
  const store = new MemoryCalendarAutojoinStore();
  const credentials = new CredentialStore(new InMemoryCredentialRowStore(), { master: () => MASTER, previousMaster: () => null });
  let revoked = 0;
  const connection = new CalendarAutojoinConnection({ store, credentials, coordinator: new TenantCoordinator(),
    calendar: { async probePrimary() {} }, oauth: {
      authorizeUrl() { return "https://accounts.google.com/o/oauth2/v2/auth"; },
      async exchangeCode() { return { access_token: "synthetic-access" }; },
      async refresh() { return { access_token: "synthetic-access" }; },
      async revoke() { revoked++; },
    } });
  await store.putConnection({ tenant: TENANT, subject: SUBJECT, state: "enabled", generation: 7,
    scopes: GOOGLE_AUTOJOIN_SCOPES.split(" "), credentialRef: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, nextScanAt: 0, scanComplete: true });
  await credentials.store({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: TENANT,
    secret: { kind: "oauth", accessToken: "synthetic-stored-access", refreshToken: "synthetic-stored-refresh" } });
  await connection.getStatus(TENANT);
  return { store, credentials, connection, revokes: () => revoked };
}

describe("TC-1100 optional connector identity and strict autojoin identity", () => {
  for (const platform of ["web/native", "desktop"] as const) {
    const clientId = platform === "desktop" ? DESKTOP : WEB;
    for (const failure of ["signature", "audience", "expiry", "issuer", "numeric_subject", "empty_subject", "presenter", "empty_presenter", "null_presenter", "certificate_fetch", "malformed_token"] as const) {
      test(`${platform}: ordinary ${failure} succeeds without identity or autojoin teardown`, async () => {
        const f = await enabledConnection();
        const before = await f.store.getConnection(TENANT);
        const cached = f.connection.getLastGoodStatus(TENANT);
        const fixture = upstream(clientId, failure);
        const realFetch = globalThis.fetch;
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        const reconnect = spyOn(f.connection, "browserReconnect");
        globalThis.fetch = fixture.fetchImpl;
        let server: Server | undefined;
        try {
          const app = express(); app.use(express.json());
          app.use((req, _res, next) => { req.user = { address: TENANT } as typeof req.user; next(); });
          // Exercise the real web AND desktop factories, rather than substituting desktopOAuth.
          app.use("/oauth", createGoogleOAuthRouter({ config: CONFIG, desktopClientId: DESKTOP, autojoin: f.connection, appOrigin: "https://app.example.test" }));
          server = app.listen(0); await new Promise<void>(done => server!.once("listening", done));
          const response = await realFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/exchange`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "synthetic-code", verifier: VERIFIER, ...(platform === "desktop" ? { desktopRedirectUri: DESKTOP_RETURN } : {}) }),
          });
          expect(response.status).toBe(200);
          const result = await response.json();
          expect(result.access_token).toBe("synthetic-access");
          expect(result.refresh_token).toBe("synthetic-refresh");
          for (const field of ["subject", "email", "id_token"]) expect(result).not.toHaveProperty(field);
          expect(reconnect.mock.calls).toHaveLength(1);
          expect(reconnect.mock.calls[0]?.[1]).toBeUndefined();
          expect(fixture.exchanges).toHaveLength(1);
          expect(fixture.exchanges[0]?.get("client_id")).toBe(clientId);
          expect(fixture.exchanges[0]?.get("client_secret")).toBe(platform === "desktop" ? null : CONFIG.clientSecret);
          expect(await f.store.getConnection(TENANT)).toEqual(before);
          expect(await f.credentials.status(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, TENANT)).not.toBeNull();
          expect(f.connection.getLastGoodStatus(TENANT)).toEqual(cached);
          expect(f.revokes()).toBe(0);
          const lines = warn.mock.calls.map(args => args.join(" "));
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/^\[google-oauth\] op=exchange identity=unverified reason=(verification_failed|subject_invalid|presenter_mismatch)$/);
          for (const privateValue of [TENANT, SUBJECT, fixture.idToken, "synthetic-refresh", "synthetic-identity@example.test"]) {
            expect(lines.some(line => line.includes(privateValue))).toBe(false);
          }
        } finally {
          globalThis.fetch = realFetch; reconnect.mockRestore(); warn.mockRestore();
          if (server) await new Promise<void>(done => server!.close(() => done()));
        }
      });

      test(`${platform}: autojoin ${failure} stays fail closed`, async () => {
        const fixture = upstream(clientId, failure);
        const client = new GoogleOAuthClient({ ...CONFIG, clientId }, { fetchImpl: fixture.fetchImpl });
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
          await expect(client.exchangeCode({ code: "synthetic-code", verifier: VERIFIER, nonce: NONCE }))
            .rejects.toMatchObject({ error: "invalid_identity", status: 400 });
        } finally { warn.mockRestore(); }
      });
    }

    for (const presenter of ["matching", "absent"] as const) {
      test(`${platform}: legitimate ${presenter} authorized presenter preserves identity`, async () => {
        const fixture = upstream(clientId, undefined, { azp: presenter === "matching" ? clientId : undefined });
        const client = new GoogleOAuthClient({ ...CONFIG, clientId }, { fetchImpl: fixture.fetchImpl });
        for (const nonce of [undefined, NONCE]) {
          expect((await client.exchangeCode({ code: "synthetic-code", verifier: VERIFIER, nonce })).subject).toBe(SUBJECT);
        }
      });
    }

    test(`${platform}: verification timeout leaves ordinary identity unknown and autojoin closed`, async () => {
      const fixture = upstream(clientId);
      const client = new GoogleOAuthClient({ ...CONFIG, clientId }, { fetchImpl: fixture.fetchImpl,
        verifyIdToken: async () => { throw new DOMException("Synthetic verifier timeout", "TimeoutError"); } });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await client.exchangeCode({ code: "synthetic-code", verifier: VERIFIER })).not.toHaveProperty("subject");
        await expect(client.exchangeCode({ code: "synthetic-code", verifier: VERIFIER, nonce: NONCE })).rejects.toMatchObject({ error: "invalid_identity" });
      } finally { warn.mockRestore(); }
    });
  }

  // Astra's production-factory regression: a substituted desktopOAuth factory cannot catch this.
  test("desktop authorization factory uses the desktop client and adds only openid", async () => {
    const app = express();
    app.use("/oauth", createGoogleOAuthRouter({ config: CONFIG, desktopClientId: DESKTOP, appOrigin: "https://app.example.test" }));
    const server = app.listen(0); await new Promise<void>(done => server.once("listening", done));
    try {
      const query = new URLSearchParams({ state: "state-0123456789abcdef", challenge: "a".repeat(43), redirectUri: DESKTOP_RETURN });
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/desktop/start?${query}`);
      expect(response.status).toBe(200);
      const url = new URL((await response.json()).authorizationUrl);
      expect(url.searchParams.get("client_id")).toBe(DESKTOP);
      expect(url.searchParams.get("scope")).toBe(`${GOOGLE_MEET_SCOPES} openid`);
    } finally { await new Promise<void>(done => server.close(() => done())); }
  });
});
