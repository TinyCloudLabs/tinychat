import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { initialBackgroundSyncState, HISTORICAL_RESYNC_CONFIRM_COPY } from "./backgroundSyncState";
import { GranolaAllowBack } from "./GranolaAllowBack";
import { FirefliesManage } from "@/capture/meetingSources/ManagePanel";

let root: Root | null = null;
let cleanup: (() => void) | null = null;
beforeEach(() => { cleanup = installDom(); });
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; cleanup?.(); });

test("Fireflies allow-back action and confirmation identify Fireflies", () => {
  const html = renderToStaticMarkup(<FirefliesManage connectorName="Fireflies"
    state={{ ...initialBackgroundSyncState(), phase: "enabled", hasSecret: true }} consentVariant="C" consentOpen={false}
    onToggleInstant={() => {}} onConfirmEnable={() => {}} onCancelEnable={() => {}} onRotate={() => {}}
    onDismissReveal={() => {}} onCopy={() => {}} onSync={() => {}} onRetry={() => {}}
    onBringBack={() => {}} onDisconnect={() => {}} />);
  expect(html).toContain("Allow deleted Fireflies meetings back");
  expect(HISTORICAL_RESYNC_CONFIRM_COPY.heading).toBe("Allow deleted Fireflies meetings back?");
  expect(HISTORICAL_RESYNC_CONFIRM_COPY.body).toContain("Fireflies");
});

test("Fireflies allow-back note sits below the action and hides while confirmation is open", () => {
  const common = {
    connectorName: "Fireflies", consentVariant: "C" as const, consentOpen: false,
    onToggleInstant: () => {}, onConfirmEnable: () => {}, onCancelEnable: () => {}, onRotate: () => {},
    onDismissReveal: () => {}, onCopy: () => {}, onSync: () => {}, onRetry: () => {},
    onBringBack: () => {}, onDisconnect: () => {},
  };
  const html = renderToStaticMarkup(<FirefliesManage {...common}
    state={{ ...initialBackgroundSyncState(), phase: "enabled", hasSecret: true, resyncConfirming: false }} />);
  const action = html.indexOf("Allow deleted Fireflies meetings back");
  const note = html.indexOf("Meetings you deleted here are collected");
  expect(action).toBeGreaterThan(-1);
  expect(note).toBeGreaterThan(action);
  expect(renderToStaticMarkup(<FirefliesManage {...common}
    state={{ ...initialBackgroundSyncState(), phase: "enabled", hasSecret: true, resyncConfirming: true }} />))
    .not.toContain("Meetings you deleted here are collected");
});

test("Google Meet allow-back action, confirmation and note identify Google Meet", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root?.render(<GranolaAllowBack source="google-meet" tcw={{} as TinyCloudWeb}
    backendUrl="https://backend.invalid" sessionStore={{} as SessionStore} note="Google Meet meetings can return after this." />));
  const action = node.querySelector("button")!;
  expect(action.textContent).toBe("Allow deleted Google Meet meetings back");
  expect(node.textContent).toContain("Google Meet meetings can return after this.");
  await act(async () => action.click());
  const confirm = node.querySelector('[role="group"]')!;
  expect(confirm.getAttribute("aria-label")).toBe("Allow deleted Google Meet meetings back?");
  expect(confirm.textContent).toContain("Google Meet");
  expect(node.textContent).not.toContain("Google Meet meetings can return after this.");
});
