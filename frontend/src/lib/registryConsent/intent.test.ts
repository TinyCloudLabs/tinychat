import { describe, expect, test } from "bun:test";
import { fakeSdk, memoryDismissedStore } from "./testClient.fixture";
import {
  hasFinishSetupRegistryIntent,
  runFinishSetupIntent,
  runSignInRegistryPublish,
  withoutFinishSetupIntent,
  type RegistryPublishEnv,
} from "./intent";

function envAt(url: string, log: string[] = []): RegistryPublishEnv & { urls: string[] } {
  const u = new URL(url);
  const urls: string[] = [];
  return {
    location: { origin: u.origin, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash },
    history: { state: { key: "s" }, replaceState: (_state, _title, next) => { urls.push(String(next)); log.push("replaceState"); } },
    urls,
  };
}

describe("the finish-setup link", () => {
  test("only finish-setup=registry counts", () => {
    expect(hasFinishSetupRegistryIntent("?finish-setup=registry")).toBe(true);
    expect(hasFinishSetupRegistryIntent("?a=1&finish-setup=registry")).toBe(true);
    expect(hasFinishSetupRegistryIntent("?finish-setup=other")).toBe(false);
    expect(hasFinishSetupRegistryIntent("?finish-setup")).toBe(false);
    expect(hasFinishSetupRegistryIntent("")).toBe(false);
  });

  test("stripping keeps the path, the other parameters and the hash", () => {
    expect(withoutFinishSetupIntent({ pathname: "/chat", search: "?finish-setup=registry", hash: "" })).toBe("/chat");
    expect(withoutFinishSetupIntent({ pathname: "/chat", search: "?a=1&finish-setup=registry&b=2", hash: "#x" })).toBe("/chat?a=1&b=2#x");
  });

  test("the query is removed BEFORE the SDK is asked, and the ask ignores an earlier Not now", async () => {
    const sdk = fakeSdk(async () => true);
    const env = envAt("https://tinycloud.one/chat?a=1&finish-setup=registry", sdk.log);
    expect(await runFinishSetupIntent(sdk.client, env, true)).toBe("published");
    expect(sdk.log).toEqual(["replaceState", "ensure"]);
    expect(env.urls).toEqual(["/chat?a=1"]);
    expect(sdk.calls).toEqual([{ options: { ignoreDismissed: true } }]);
  });

  test("it works past a Not now the owner gave earlier", async () => {
    const sdk = fakeSdk(async () => true);
    const store = memoryDismissedStore();
    store.write(sdk.client.did);
    expect(await runSignInRegistryPublish(sdk.client, envAt("https://tinycloud.one/"), true, store)).toBe("dismissed");
    expect(sdk.calls).toEqual([]);
    expect(await runFinishSetupIntent(sdk.client, envAt("https://tinycloud.one/?finish-setup=registry"), true)).toBe("published");
  });

  test("no link: nothing is asked and the address is not touched", async () => {
    const sdk = fakeSdk(async () => true);
    const env = envAt("https://tinycloud.one/chat");
    expect(await runFinishSetupIntent(sdk.client, env, true)).toBe("no-intent");
    expect(sdk.calls).toEqual([]);
    expect(env.urls).toEqual([]);
  });

  test("another site's page never asks, and keeps its address", async () => {
    const sdk = fakeSdk(async () => true);
    const env = envAt("https://example.com/?finish-setup=registry");
    expect(await runFinishSetupIntent(sdk.client, env, true)).toBe("not-first-party");
    expect(sdk.calls).toEqual([]);
    expect(env.urls).toEqual([]);
  });

  test("off: the address is not touched and the SDK is not asked", async () => {
    const sdk = fakeSdk(async () => true);
    const env = envAt("https://tinycloud.one/?finish-setup=registry");
    expect(await runFinishSetupIntent(sdk.client, env, false)).toBe("off");
    expect(sdk.calls).toEqual([]);
    expect(env.urls).toEqual([]);
  });

  test("an SDK without ensureOwnerRegistryRecord: no call, and the address is left alone", async () => {
    const env = envAt("https://tinycloud.one/?finish-setup=registry");
    const withoutMethod = { did: "did:pkh:eip155:1:0xabc" };
    expect(await runFinishSetupIntent(withoutMethod, env, true)).toBe("off");
    expect(await runSignInRegistryPublish(withoutMethod, env, true, memoryDismissedStore())).toBe("off");
    expect(env.urls).toEqual([]);
  });
});

describe("after a fresh sign-in", () => {
  test("a different owner than the one who said Not now is asked", async () => {
    const sdk = fakeSdk(async () => true);
    const store = memoryDismissedStore();
    store.write("did:pkh:eip155:1:0xsomeoneelse");
    expect(await runSignInRegistryPublish(sdk.client, envAt("https://tinycloud.one/"), true, store)).toBe("published");
  });

  test("asks once, without ignoring Not now", async () => {
    const sdk = fakeSdk(async () => true);
    expect(await runSignInRegistryPublish(sdk.client, envAt("https://tinycloud.one/"), true, memoryDismissedStore())).toBe("published");
    expect(sdk.calls).toEqual([{ options: {} }]);
  });

  test("a finish-setup link on the page is left to the link's own ask", async () => {
    const sdk = fakeSdk(async () => true);
    expect(await runSignInRegistryPublish(sdk.client, envAt("https://tinycloud.one/?finish-setup=registry"), true, memoryDismissedStore())).toBe("deferred-to-link");
    expect(sdk.calls).toEqual([]);
  });

  test("the legacy hostnames count as TinyCloud's own pages", async () => {
    for (const url of ["https://tinycloud.chat/", "https://home.tinycloud.xyz/"]) {
      const sdk = fakeSdk(async () => true);
      expect(await runSignInRegistryPublish(sdk.client, envAt(url), true, memoryDismissedStore())).toBe("published");
    }
  });
});
