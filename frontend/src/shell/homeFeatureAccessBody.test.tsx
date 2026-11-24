import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { FEATURE_ACCESS_BODY } from "@/lib/homeStrings";
import { HomeFeatureAccessContext, HomeFeatureGate, useHomeFeatureAccessState } from "./homeFeatureAccess";

// The Connectors card says what the approval opens. It follows the switch that decides the grant the approval asks for.

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];

let restoreDom: () => void;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom();
  if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag;
});

async function cardText(): Promise<string> {
  function Page() {
    const access = useHomeFeatureAccessState({
      enabled: true, tcw: { hasPermissions: () => false, kv: {} as TinyCloudWeb["kv"] }, address: ADDRESS,
      store: { getItem: () => null, setItem: () => {} }, requestFeatureAccess: async () => "declined", inFlight: null,
    });
    return <HomeFeatureAccessContext.Provider value={access}><HomeFeatureGate feature="connectors"><div /></HomeFeatureGate></HomeFeatureAccessContext.Provider>;
  }
  await act(async () => root.render(<Page />));
  return host.textContent ?? "";
}

test("with the named-key switch on, the card says the approval opens only the connector keys", async () => {
  buildEnv[BUILD_FLAG] = "true";
  const text = await cardText();
  expect(text).toContain(FEATURE_ACCESS_BODY.connectors);
  expect(text).toContain("opens only those keys");
});

test("with the named-key switch off, the card still says the approval opens only those keys and does not offer to unlock everything", async () => {
  delete buildEnv[BUILD_FLAG];
  const text = await cardText();
  expect(text).toContain(FEATURE_ACCESS_BODY.connectors);
  expect(text).toContain("opens only those keys");
  expect(text).not.toContain("unlock everything encrypted to your account");
});
