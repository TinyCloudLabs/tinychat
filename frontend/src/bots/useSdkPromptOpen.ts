import { useSyncExternalStore } from "react";

const sdkRoot = () => document.querySelector("[data-tinycloud-ui]")?.shadowRoot;
const sdkPrompt = () => sdkRoot()?.querySelector("tinycloud-permission-request-modal, tinycloud-space-modal");
const promptOpen = () => typeof document !== "undefined" && !!sdkPrompt();
export const focusSdkPrompt = () => sdkPrompt()?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]')?.focus();

// TC-2902: replace this SDK3.11.2 DOM bridge when the SDK exposes prompt lifecycle events.
function subscribe(changed: () => void) {
  let root: ShadowRoot | null | undefined;
  const prompts = new MutationObserver(changed);
  const observeHost = () => {
    const next = sdkRoot();
    if (next !== root) {
      prompts.disconnect();
      root = next;
      if (root) prompts.observe(root, { childList: true, subtree: true });
    }
    changed();
  };
  const body = new MutationObserver(observeHost);
  body.observe(document.body, { childList: true });
  observeHost();
  return () => { body.disconnect(); prompts.disconnect(); };
}

export const useSdkPromptOpen = () => useSyncExternalStore(subscribe, promptOpen, () => false);
