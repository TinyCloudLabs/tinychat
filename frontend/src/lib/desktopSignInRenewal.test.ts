import { describe, expect, mock, test } from "bun:test";
import type { ConnectWalletResult, TinyCloudWebConfig } from "@tinyboilerplate/client";
import { withConnectorKeyGrants } from "./connectors/encryptionGrant";
import { desktopSignInWithRenewal, webSignInRenewal } from "./renewalReceipt";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST = {
  protocolVersion: 1 as const,
  siwe: "prepared desktop SIWE",
  expiryChangeable: true,
};
const APPROVED = {
  protocolVersion: 1 as const,
  address: ADDRESS,
  signedMessage: "approved desktop SIWE",
  signature: "signature",
  selectedActionKeys: [],
  permissions: [],
};

function desktopRenewal(authorizeTinyCloud: ConnectWalletResult["openkey"]["authorizeTinyCloud"]) {
  const openkey = { authorizeTinyCloud } as ConnectWalletResult["openkey"];
  return webSignInRenewal(openkey, withConnectorKeyGrants(WEB_APP_MANIFEST, ADDRESS));
}

function exerciseSignIn(config?: TinyCloudWebConfig) {
  return config?.openkey ? config.openkey.client.authorizeTinyCloud(REQUEST, { mode: config.openkey.mode }) : Promise.resolve(APPROVED);
}

describe("desktop sign-in renewal", () => {
  test("asks in the iframe for a 90-day lease on a grant capped at seven days", async () => {
    const authorize = mock(async () => APPROVED);
    const { config } = desktopRenewal(authorize);
    expect(config.sessionExpirationMs).toBe(SEVEN_DAYS_MS);
    expect(config.openkey.maxExpiresAt()).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS);
    const signIn = mock(exerciseSignIn);

    expect(await desktopSignInWithRenewal(config, signIn)).toEqual(APPROVED);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({
      ...REQUEST,
      renewal: { version: 1, leaseLifetimeSeconds: 90 * 24 * 60 * 60, purpose: "standing" },
    }, { mode: "iframe" });
  });

  test("a failed OpenKey authorization can fall back to finite wallet sign-in", async () => {
    const { config } = desktopRenewal(async () => { throw { code: "TIMEOUT" }; });
    const signIn = mock(exerciseSignIn);

    expect(await desktopSignInWithRenewal(config, signIn)).toEqual(APPROVED);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(signIn.mock.calls[1]).toEqual([]);
  });

  test.each(["USER_CANCELLED", "APP_KEY_GRANT_REFUSED", "ACTION_REJECTED", 4001])(
    "leaves a cancellation or refusal with code %s in place",
    async (code) => {
      const error = { code };
      const { config } = desktopRenewal(async () => { throw error; });
      const signIn = mock(exerciseSignIn);

      await expect(desktopSignInWithRenewal(config, signIn)).rejects.toBe(error);
      expect(signIn).toHaveBeenCalledTimes(1);
    },
  );

  test("an SDK failure after authorization leaves the signed result alone", async () => {
    const { config } = desktopRenewal(async () => APPROVED);
    const error = new Error("Node did not register the signed grant");
    const signIn = mock(async (config?: TinyCloudWebConfig) => {
      await exerciseSignIn(config);
      throw error;
    });

    await expect(desktopSignInWithRenewal(config, signIn)).rejects.toBe(error);
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});
