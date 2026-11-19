import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_RUNTIME_FLAG_KEY } from "./replicationFlag";
import { replicationOptInKey, replicationPrincipalFor } from "./replicationOptIn";
import { replicationRestorePatch } from "./replicationRestore";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const GLOBAL_NAMES = ["window", "navigator", "indexedDB", "Worker"] as const;

function install(store: Map<string, string>): void {
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  });
  define("navigator", { userAgent: CHROME, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: () => undefined } });
  define("indexedDB", {});
  define("Worker", class {});
}

function loader(): ReplicationPluginLoader {
  return { registerPlugin: async () => undefined, createStorage: async () => ({ sentinel: "storage" }) as never };
}

describe("the restore patch", () => {
  let saved = new Map<string, PropertyDescriptor | undefined>();
  let savedBuildFlag: string | undefined;
  beforeEach(() => {
    saved = new Map(GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    savedBuildFlag = import.meta.env.VITE_EXO_REPLICATION;
    import.meta.env.VITE_EXO_REPLICATION = "false"; // the build flag is ON unless "false"; the dev runtime flag below stands in for it
  });
  afterEach(() => {
    import.meta.env.VITE_EXO_REPLICATION = savedBuildFlag;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });

  test("replication ON: the replication option AND a provider that answers the stored address", async () => {
    install(new Map([[REPLICATION_RUNTIME_FLAG_KEY, "true"], [replicationOptInKey(replicationPrincipalFor(ALICE)), "true"]]));
    const patch = await replicationRestorePatch(ALICE, loader());
    expect(patch.replication?.enabled).toBe(true);
    expect(await patch.provider?.request({ method: "eth_accounts" })).toEqual([ALICE]);
    await expect(patch.provider?.request({ method: "personal_sign" })).rejects.toMatchObject({ code: 4200 });
  });

  test("replication OFF for this account: exactly {} (no provider, no signer, config unchanged)", async () => {
    // Build flag on, platform qualified, but this account explicitly opted out (another account did not).
    install(new Map([[REPLICATION_RUNTIME_FLAG_KEY, "true"], [replicationOptInKey(replicationPrincipalFor(ALICE)), "false"]]));
    expect(await replicationRestorePatch(ALICE, loader())).toEqual({});
  });

  test("build flag off: exactly {}, even with the user's switch on", async () => {
    install(new Map([[replicationOptInKey(replicationPrincipalFor(ALICE)), "true"]]));
    const patch = await replicationRestorePatch(ALICE, loader());
    expect(patch).toEqual({});
    expect("provider" in patch).toBe(false);
  });

  test("the provider answers the address of the session being restored, not another account's", async () => {
    install(new Map([
      [REPLICATION_RUNTIME_FLAG_KEY, "true"],
      [replicationOptInKey(replicationPrincipalFor(ALICE)), "true"],
      [replicationOptInKey(replicationPrincipalFor(BOB)), "true"],
    ]));
    expect(await (await replicationRestorePatch(BOB, loader())).provider?.request({ method: "eth_accounts" })).toEqual([BOB]);
  });
});
