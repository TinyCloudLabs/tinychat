import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { FEATURE_ACCESS_BODY, FEATURE_ACCESS_PARTIAL } from "@/lib/homeStrings";
import {
  HomeFeatureAccessContext,
  HomeFeatureGate,
  useHomeFeatureAccessState,
  type FeatureAccessOutcome,
} from "./homeFeatureAccess";

const ADDRESS = "0x00000000000000000000000000000000000000a1";

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
});

const button = (label: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent === label) as HTMLButtonElement | undefined;
async function click(label: string) {
  await act(async () => { button(label)!.click(); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("the card says OpenKey also asks to unlock encrypted data", async () => {
  function Page() {
    const access = useHomeFeatureAccessState({
      enabled: true, tcw: { hasPermissions: () => false, kv: {} as TinyCloudWeb["kv"] }, address: ADDRESS,
      store: { getItem: () => null, setItem: () => {} }, requestFeatureAccess: async () => "declined", inFlight: null,
    });
    return <HomeFeatureAccessContext.Provider value={access}><HomeFeatureGate feature="connectors"><div /></HomeFeatureGate></HomeFeatureAccessContext.Provider>;
  }
  await act(async () => root.render(<Page />));
  expect(host.textContent).toContain(FEATURE_ACCESS_BODY.connectors);
  expect(host.textContent).toContain("To read those keys, TinyCloud One also asks to use your master key, which opens everything encrypted to your account, including data other apps saved.");
});

test("when everything but unlocking encrypted data was allowed, the card says so, keeps waiting, marks nothing allowed, and Continue asks again", async () => {
  const stored = new Map<string, string>();
  const answers: FeatureAccessOutcome[] = ["partial", "partial"];
  let asked = 0;
  function Page() {
    const access = useHomeFeatureAccessState({
      enabled: true, tcw: { hasPermissions: () => false, kv: { get: async () => { throw new Error("must not be read"); } } as unknown as TinyCloudWeb["kv"] },
      address: ADDRESS,
      store: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } },
      requestFeatureAccess: async () => { asked += 1; return answers.shift()!; },
      inFlight: null,
    });
    return <HomeFeatureAccessContext.Provider value={access}>
      <HomeFeatureGate feature="connectors"><div data-testid="connectors-screen" /></HomeFeatureGate>
    </HomeFeatureAccessContext.Provider>;
  }
  await act(async () => root.render(<Page />));
  await click("Continue");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(FEATURE_ACCESS_PARTIAL);
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeNull();
  expect(stored.size).toBe(0);
  expect(button("Continue")?.disabled).toBe(false);
  expect(button("Not now")).toBeTruthy();
  await click("Continue");
  expect(asked).toBe(2);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(FEATURE_ACCESS_PARTIAL);
  expect(stored.size).toBe(0);
});
