// Android's hardware Back (TC-761), carried out from backDecision.ts. Only the
// Android app registers it: registering a listener replaces Capacitor's
// default (history back, then exit), so the app minimises at home instead of
// exiting. iOS has no hardware Back; pushed screens show a Back button.
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";

import type { AppPlatform } from "../lib/platform";
import { useSizeClass } from "../lib/sizeClass";
import { decideBack } from "./backDecision";
import { historyIndex } from "./navigation";
import { homeDestination, homePath, type Screen } from "./routes";

const OVERLAYS = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-overlay-open="true"]';

/** The open sheet, dialog or popover on top: the last one in document order. */
export function topOverlay(doc: Document = document): HTMLElement | null {
  const open = doc.querySelectorAll<HTMLElement>(OVERLAYS);
  return open.length > 0 ? open[open.length - 1]! : null;
}

/**
 * Closes an overlay the way Escape does, so each one's own close path runs
 * (Radix, vaul, the model and usage popovers). An overlay that refuses Escape
 * while it is busy (ConnectorDialog) refuses Back too.
 */
export function dismissOverlay(overlay: HTMLElement): void {
  overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

/** Back for the current screen, as one stable callback. `onMinimize` runs at home. */
export function useBack(input: { screen: Screen; platform: AppPlatform; onMinimize: () => void }): () => void {
  const navigate = useNavigate();
  const { size } = useSizeClass();
  const latest = useRef({ ...input, size, navigate });
  latest.current = { ...input, size, navigate };
  return useCallback(() => {
    const { screen, platform, onMinimize, size: currentSize, navigate: go } = latest.current;
    const overlay = topOverlay();
    const action = decideBack({
      overlay: overlay !== null,
      screen,
      size: currentSize,
      historyIdx: historyIndex(),
      homeDestination: homeDestination(platform),
      homePath: homePath(platform),
    });
    switch (action.kind) {
      case "dismiss-overlay":
        if (overlay) dismissOverlay(overlay);
        return;
      case "history-back":
        go(-1);
        return;
      case "navigate":
        go(action.to, { replace: action.replace });
        return;
      case "minimize":
        onMinimize();
        return;
    }
  }, []);
}

export function useAndroidBack(input: { screen: Screen; platform: AppPlatform }): void {
  const back = useBack({ ...input, onMinimize: () => void CapacitorApp.minimizeApp() });
  useEffect(() => {
    if (input.platform !== "android") return;
    const handle = CapacitorApp.addListener("backButton", () => back());
    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, [input.platform, back]);
}
