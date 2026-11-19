import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";

import { frontendOriginsFromEnv, HOME_WEB_ORIGIN, TINYCHAT_WEB_ORIGIN, TINYCLOUD_ONE_WEB_ORIGIN } from "../cors-origins.js";
import { createGoogleOAuthRouter } from "../routes/google-oauth.js";
import {
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_MEET_SCOPES,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthClient,
  type GoogleOAuthConfig,
  type GoogleOAuthPort,
  type GoogleTokenPayload,
} from "../services/google-oauth.js";

/**
 * Where a Google flow returns when the web app's FRONTEND_URL is tinycloud.one. Visitors held on
 * tinycloud.chat (`tc_hold`, `?legacy=1`) start their flows there UNTAGGED, so those flows must finish on
 * tinycloud.chat whatever FRONTEND_URL is; flows tagged by tinycloud.one or home.tinycloud.xyz keep their own origin.
 */

const CONFIG: GoogleOAuthConfig = {
  enabled: true,
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://api.example.test/api/connectors/google/oauth/callback",
  scope: GOOGLE_MEET_SCOPES,
  authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
  tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
};
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const NONCE = "abcdefghijklmnopqrstuvwx";

class Port implements GoogleOAuthPort {
  authorizeUrl(input: { state: string; challenge: string }): string {
    return new GoogleOAuthClient(CONFIG).authorizeUrl(input);
  }
  async exchangeCode(): Promise<GoogleTokenPayload> {
    return { access_token: "fake-access-token", refresh_token: "fake-refresh-token" };
  }
  async refresh(): Promise<GoogleTokenPayload> {
    return { access_token: "fake-access-token", expires_in: 3599 };
  }
  async revoke(): Promise<void> {}
}

const tabState = (tag: "tab" | "hometab" | "onetab", path: string) =>
  `${tag}.${Buffer.from(path).toString("base64url")}.${NONCE}`;

async function withFlow(
  frontendUrl: string,
  run: (flow: { callback: (state: string) => Promise<Response>; start: (state: string) => Promise<Response> }) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use("/oauth", createGoogleOAuthRouter({
    oauth: new Port(), config: CONFIG, appOrigin: frontendUrl,
    frontendOrigins: frontendOriginsFromEnv(frontendUrl, {}),
  }));
  const listener = app.listen(0);
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/oauth`;
  try {
    await run({
      start: (state) => fetch(`${url}/start?${new URLSearchParams({ state, challenge: CHALLENGE })}`, { redirect: "manual" }),
      callback: (state) => fetch(`${url}/callback?${new URLSearchParams({ state, code: "fake-code" })}`, { redirect: "manual" }),
    });
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

describe("with FRONTEND_URL=https://tinycloud.one", () => {
  test("an untagged popup flow posts its result to tinycloud.chat, not tinycloud.one", async () => {
    await withFlow(TINYCLOUD_ONE_WEB_ORIGIN, async ({ start, callback }) => {
      expect((await start(NONCE)).status).toBe(302);
      const popup = await callback(NONCE);
      expect(popup.status).toBe(200);
      const html = await popup.text();
      expect(html).toContain(`postMessage(payload, "${TINYCHAT_WEB_ORIGIN}")`);
      expect(html).not.toContain(TINYCLOUD_ONE_WEB_ORIGIN);
      expect(html).not.toContain(HOME_WEB_ORIGIN);
    });
  });

  test("an untagged same-tab flow lands on tinycloud.chat at its own path with the code", async () => {
    await withFlow(TINYCLOUD_ONE_WEB_ORIGIN, async ({ start, callback }) => {
      const state = tabState("tab", "/chat/connectors");
      expect((await start(state)).status).toBe(302);
      const response = await callback(state);
      expect(response.status).toBe(302);
      const tab = new URL(response.headers.get("location")!);
      expect(tab.origin).toBe(TINYCHAT_WEB_ORIGIN);
      expect(tab.pathname).toBe("/chat/connectors");
      expect(tab.searchParams.get("google_oauth_code")).toBe("fake-code");
    });
  });

  test("flows tagged by tinycloud.one and home.tinycloud.xyz still return to their own origin", async () => {
    await withFlow(TINYCLOUD_ONE_WEB_ORIGIN, async ({ start, callback }) => {
      expect((await start(`one.${NONCE}`)).status).toBe(302);
      expect(await (await callback(`one.${NONCE}`)).text()).toContain(`postMessage(payload, "${TINYCLOUD_ONE_WEB_ORIGIN}")`);
      const oneTab = tabState("onetab", "/chat/connectors");
      expect((await start(oneTab)).status).toBe(302);
      expect(new URL((await callback(oneTab)).headers.get("location")!).origin).toBe(TINYCLOUD_ONE_WEB_ORIGIN);

      expect((await start(`home.${NONCE}`)).status).toBe(302);
      expect(await (await callback(`home.${NONCE}`)).text()).toContain(`postMessage(payload, "${HOME_WEB_ORIGIN}")`);
      const homeTab = tabState("hometab", "/chat/connectors");
      expect((await start(homeTab)).status).toBe(302);
      expect(new URL((await callback(homeTab)).headers.get("location")!).origin).toBe(HOME_WEB_ORIGIN);
    });
  });
});

describe("with FRONTEND_URL=https://home.tinycloud.xyz", () => {
  test("untagged flows return to tinycloud.chat and tinycloud.one flows to tinycloud.one", async () => {
    await withFlow(HOME_WEB_ORIGIN, async ({ start, callback }) => {
      expect((await start(NONCE)).status).toBe(302);
      expect(await (await callback(NONCE)).text()).toContain(`postMessage(payload, "${TINYCHAT_WEB_ORIGIN}")`);
      expect((await start(`one.${NONCE}`)).status).toBe(302);
      expect(await (await callback(`one.${NONCE}`)).text()).toContain(`postMessage(payload, "${TINYCLOUD_ONE_WEB_ORIGIN}")`);
    });
  });
});
