import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { FEATURE_ACCESS_FAILED, FEATURE_ACCESS_NARROWED } from "@/lib/homeStrings";
import { HomeFeatureAccessContext, HomeFeaturePrompt, type FeatureAccessOutcome, type HomeFeatureAccess } from "./homeFeatureAccess";

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

async function ask(outcome: FeatureAccessOutcome): Promise<string> {
  const access: HomeFeatureAccess = { covered: () => false, request: async () => outcome, confirmUse: () => {}, inFlight: null };
  await act(async () => root.render(<HomeFeatureAccessContext.Provider value={access}><HomeFeaturePrompt feature="connectors" /></HomeFeatureAccessContext.Provider>));
  const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Continue")!;
  await act(async () => { button.click(); });
  return host.querySelector('[role="alert"]')?.textContent ?? "";
}

test("an approval the owner narrowed says which permissions Connectors needs and how to try again, never the generic failure", async () => {
  const line = await ask("narrowed");
  expect(line).toBe(FEATURE_ACCESS_NARROWED.connectors);
  expect(line).not.toBe(FEATURE_ACCESS_FAILED);
  expect(line).toContain("keep every permission ticked");
});

test("a real failure still shows the generic line", async () => {
  expect(await ask("failed")).toBe(FEATURE_ACCESS_FAILED);
});
