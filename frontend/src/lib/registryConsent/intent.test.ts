import { describe, expect, test } from "bun:test";
import { fakeSdk } from "./testClient.fixture";
import {
  hasFinishSetupRegistryIntent,
  runFinishSetupIntent,
  withoutFinishSetupIntent,
  type RegistryPublishEnv,
} from "./intent";

function envAt(url: string, log: string[] = []): RegistryPublishEnv & { urls: string[] } {
  const u = new URL(url);
  const urls: string[] = [];
  return {
    location: { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash },
    history: { state: { key: "s" }, replaceState: (_state, _title, next) => { urls.push(String(next)); log.push("replaceState"); } },
    urls,
  };
}

const neverOpens = async () => { throw new Error("the setup link must not open"); };

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

  test("the query is removed BEFORE the SDK is asked, and the ask carries no arguments", async () => {
    const sdk = fakeSdk("published");
    const env = envAt("https://tinycloud.one/chat?a=1&finish-setup=registry", sdk.log);
    expect(await runFinishSetupIntent(sdk.client, env, neverOpens)).toBe("published");
    expect(sdk.log).toEqual(["replaceState", "ensure"]);
    expect(env.urls).toEqual(["/chat?a=1"]);
    expect(sdk.calls).toEqual([[]]);
  });

  test("no link: nothing is asked and the address is not touched", async () => {
    const sdk = fakeSdk("published");
    const env = envAt("https://tinycloud.one/chat");
    expect(await runFinishSetupIntent(sdk.client, env, neverOpens)).toBe("no-intent");
    expect(sdk.calls).toEqual([]);
    expect(env.urls).toEqual([]);
  });

  test("another site's page asks the SDK, which decides, and needs-one sends the owner to TinyCloud One", async () => {
    const sdk = fakeSdk("needs-one");
    const opened: string[] = [];
    const env = envAt("https://app.tinycloud.one/chat?finish-setup=registry");
    expect(await runFinishSetupIntent(sdk.client, env, async (origin) => { opened.push(origin); })).toBe("needs-one");
    expect(sdk.calls).toEqual([[]]);
    expect(env.urls).toEqual(["/chat"]);
    expect(opened).toEqual(["https://app.tinycloud.one"]);
  });

  test("only needs-one opens the setup link", async () => {
    for (const outcome of ["published", "already-current", "unavailable"] as const) {
      const sdk = fakeSdk(outcome);
      expect(await runFinishSetupIntent(sdk.client, envAt("https://tinycloud.one/?finish-setup=registry"), neverOpens)).toBe(outcome);
    }
  });
});
