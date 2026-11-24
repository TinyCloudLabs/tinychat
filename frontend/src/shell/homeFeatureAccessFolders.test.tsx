import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { FEATURE_ACCESS_PARTIAL, FEATURE_ACCESS_PARTIAL_FOLDERS } from "@/lib/homeStrings";
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

async function outcomeLine(outcome: FeatureAccessOutcome) {
  const stored = new Map<string, string>();
  function Page() {
    const access = useHomeFeatureAccessState({
      enabled: true, tcw: { hasPermissions: () => false, kv: { get: async () => { throw new Error("must not be read"); } } as unknown as TinyCloudWeb["kv"] },
      address: ADDRESS,
      store: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } },
      requestFeatureAccess: async () => outcome,
      inFlight: null,
    });
    return <HomeFeatureAccessContext.Provider value={access}>
      <HomeFeatureGate feature="connectors"><div data-testid="connectors-screen" /></HomeFeatureGate>
    </HomeFeatureAccessContext.Provider>;
  }
  await act(async () => root.render(<Page />));
  await click("Continue");
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeNull();
  expect(stored.size).toBe(0);
  expect(button("Continue")?.disabled).toBe(false);
  expect(button("Not now")).toBeTruthy();
  return host.querySelector('[role="alert"]')?.textContent;
}

test("when the folder permissions were left out, the card names the folders, keeps waiting and marks nothing allowed", async () => {
  expect(await outcomeLine("partial-folders")).toBe(FEATURE_ACCESS_PARTIAL_FOLDERS);
});

test("when only the unlock permission was left out, the card keeps its own message", async () => {
  expect(await outcomeLine("partial")).toBe(FEATURE_ACCESS_PARTIAL);
});
