// A brand-new account has no encryption network: its first connector key save answers `network_not_found` (TC-4243).
// The save asks the owner once for `network.create` on that network, makes it, and retries the put once.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";

import { saveConnectorKey, getConnectorKey, resetVaultSecretCacheForTests } from "./connectorSecrets";
import {
  CONNECTOR_NETWORK_SETUP_DESCRIPTION,
  CONNECTOR_NETWORK_SETUP_MAX_MS,
  encryptionNetworkId,
} from "./encryptionGrant";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const NETWORK_MISSING = {
  code: "STORAGE_ERROR",
  message: "failed to tinycloud.encryption/key.create: network_not_found",
};

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realBuildFlag = buildEnv[BUILD_FLAG];
beforeEach(() => {
  resetVaultSecretCacheForTests();
  buildEnv[BUILD_FLAG] = "true";
});
afterEach(() => {
  if (realBuildFlag === undefined) delete buildEnv[BUILD_FLAG];
  else buildEnv[BUILD_FLAG] = realBuildFlag;
});

type PutResult = { ok: true } | { ok: false; error: unknown };

/** A fake session whose puts answer from `results` (then succeed) and which records everything the save does. */
function fakeTcw(results: PutResult[]) {
  const events: string[] = [];
  const puts: { value: string; options: unknown }[] = [];
  const stored = new Map<string, string>();
  const tcw = {
    did: "did:pkh:eip155:1:" + ADDRESS,
    secrets: {
      isUnlocked: true,
      put: async (name: string, value: string, options?: unknown) => {
        events.push("put");
        puts.push({ value, options });
        const result = results.shift() ?? { ok: true as const };
        if (result.ok) stored.set(name, value);
        return result;
      },
      get: async (name: string) => {
        const value = stored.get(name);
        return value === undefined ? { ok: false, error: { code: "KEY_NOT_FOUND", message: "missing" } } : { ok: true, data: value };
      },
    },
    session: () => ({ address: ADDRESS, chainId: 1 }),
    ensureEncryptionNetwork: async () => { events.push("ensure"); return {}; },
    ensureOwnedSpaceHosted: async () => { events.push("host"); },
  } as unknown as TinyCloudWeb;
  return { tcw, events, puts, stored };
}

function approver(answer: boolean | Error) {
  const asked: { permissions: PermissionEntry[]; maxExpiryMs: number }[] = [];
  return {
    asked,
    requestApproval: async (permissions: PermissionEntry[], maxExpiryMs: number) => {
      asked.push({ permissions, maxExpiryMs });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const FIREFLIES = { secretName: "FIREFLIES_API_KEY" };

describe("the first key save of a new account", () => {
  test("asks, makes the network, retries the put once, and the key is stored", async () => {
    const { tcw, events, puts, stored } = fakeTcw([{ ok: false, error: NETWORK_MISSING }]);
    const ask = approver(true);
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
    expect(result.ok).toBe(true);
    expect(events).toEqual(["put", "ensure", "put"]);
    expect(ask.asked).toHaveLength(1);
    expect(puts.map((p) => p.options)).toEqual([{ namedKey: true }, { namedKey: true }]);
    expect(stored.get("FIREFLIES_API_KEY")).toBe("k1");
    const read = await getConnectorKey(tcw, FIREFLIES);
    expect(read.ok && read.data).toBe("k1");
  });

  test("the request is one entry with exactly network.create on the account's network, short lived, with a plain description", async () => {
    const { tcw } = fakeTcw([{ ok: false, error: NETWORK_MISSING }]);
    const ask = approver(true);
    await saveConnectorKey(tcw, { secretName: "REFRESH_TOKEN", secretScope: "google-meet" }, "t1", ask);
    expect(ask.asked).toHaveLength(1);
    const [{ permissions, maxExpiryMs }] = ask.asked;
    expect(permissions).toEqual([{
      service: "tinycloud.encryption",
      path: encryptionNetworkId(ADDRESS, 1),
      skipPrefix: true,
      actions: ["network.create"],
      description: CONNECTOR_NETWORK_SETUP_DESCRIPTION,
    }]);
    expect(permissions[0].actions).not.toContain("decrypt");
    expect(maxExpiryMs).toBe(CONNECTOR_NETWORK_SETUP_MAX_MS);
    expect(maxExpiryMs).toBeLessThanOrEqual(3_600_000);
  });

  test("a decline keeps the original error and stores nothing", async () => {
    const { tcw, events, stored } = fakeTcw([{ ok: false, error: NETWORK_MISSING }]);
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", approver(false));
    expect(result).toEqual({ ok: false, error: NETWORK_MISSING });
    expect(events).toEqual(["put"]);
    expect(stored.size).toBe(0);
    const read = await getConnectorKey(tcw, FIREFLIES);
    expect(read.ok).toBe(false);
  });

  test("a failed ask keeps the original error, makes no network and retries nothing", async () => {
    const { tcw, events, stored } = fakeTcw([{ ok: false, error: NETWORK_MISSING }]);
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", approver(new Error("owner_changed")));
    expect(result).toEqual({ ok: false, error: NETWORK_MISSING });
    expect(events).toEqual(["put"]);
    expect(stored.size).toBe(0);
  });

  test("a network that cannot be made keeps the original error and does not retry the put", async () => {
    const { tcw, events } = fakeTcw([{ ok: false, error: NETWORK_MISSING }]);
    (tcw as unknown as { ensureEncryptionNetwork: () => Promise<never> }).ensureEncryptionNetwork = async () => {
      events.push("ensure");
      throw new Error("node refused");
    };
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", approver(true));
    expect(result).toEqual({ ok: false, error: NETWORK_MISSING });
    expect(events).toEqual(["put", "ensure"]);
  });

  test("asks once per save: a retry that still fails does not ask again or loop", async () => {
    const { tcw, events } = fakeTcw([{ ok: false, error: NETWORK_MISSING }, { ok: false, error: NETWORK_MISSING }]);
    const ask = approver(true);
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
    expect(result).toEqual({ ok: false, error: NETWORK_MISSING });
    expect(ask.asked).toHaveLength(1);
    expect(events).toEqual(["put", "ensure", "put"]);
  });

  test("a second save is a new attempt and may ask again", async () => {
    const { tcw } = fakeTcw([{ ok: false, error: NETWORK_MISSING }, { ok: false, error: NETWORK_MISSING }, { ok: false, error: NETWORK_MISSING }, { ok: false, error: NETWORK_MISSING }]);
    const ask = approver(false);
    await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
    await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
    expect(ask.asked).toHaveLength(2);
  });
});

describe("no ask for anything but network_not_found", () => {
  const others: [string, unknown][] = [
    ["a different storage error", { code: "STORAGE_ERROR", message: "failed to put: quota exceeded" }],
    ["a locked vault", { code: "VAULT_LOCKED", message: "locked" }],
    ["a permission error", { code: "PERMISSION_DENIED", message: "network.create not granted" }],
    ["a conflict", { code: "CONFLICT", message: "already written" }],
  ];
  for (const [label, error] of others) {
    test(`${label} is returned as it is with no ask`, async () => {
      const { tcw, events } = fakeTcw([{ ok: false, error }]);
      const ask = approver(true);
      const result = await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
      expect(result).toEqual({ ok: false, error });
      expect(ask.asked).toHaveLength(0);
      expect(events).toEqual(["put"]);
    });
  }

  test("a space that is not hosted still takes the hosting retry and no ask", async () => {
    const { tcw, events } = fakeTcw([{ ok: false, error: { code: "SPACE_NOT_FOUND", message: "Space not found" } }]);
    const ask = approver(true);
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
    expect(result.ok).toBe(true);
    expect(ask.asked).toHaveLength(0);
    expect(events).toEqual(["put", "host", "put"]);
  });
});

describe("with the named-key switch off nothing changes", () => {
  test("network_not_found is returned from the plain put with no ask", async () => {
    delete buildEnv[BUILD_FLAG];
    const { tcw, events, puts } = fakeTcw([{ ok: false, error: NETWORK_MISSING }]);
    const ask = approver(true);
    const result = await saveConnectorKey(tcw, FIREFLIES, "k1", ask);
    expect(result).toEqual({ ok: false, error: NETWORK_MISSING });
    expect(ask.asked).toHaveLength(0);
    expect(events).toEqual(["put"]);
    expect(puts.map((p) => p.options)).toEqual([undefined]);
  });
});
