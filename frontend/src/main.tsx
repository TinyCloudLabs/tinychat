import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import "./index.css";
import { App } from "./App";
import { installEd25519Polyfill } from "./lib/ed25519Polyfill";
import { CaptureEngineGate } from "./capture/recorder/CaptureEngineGate";
import { PwaPrompts } from "./components/pwa-prompts";
import { RootErrorBoundary } from "./shell/RootErrorBoundary";
import { OriginMoveHold } from "./shell/OriginMoveNotice";
import { clearMovedAnswers, decideOriginMove, isLegacyOrigin, type OriginMoveDecision } from "./lib/originMove";
import { AboutRedirect, RootRoute } from "./landing/RootRoute";
import { registerWebCaptureEngine } from "./lib/voiceNotes/web/registerWebEngine";
import { appPlatform } from "./lib/platform";
import { setIOSDynamicTypeScale } from "./lib/dynamicType";
import { setupPwa } from "./lib/pwa";
import { initSizeClass } from "./lib/sizeClass";
import { initTheme } from "./lib/theme";
import { registerDesktopVoiceNotes } from "./lib/voiceNotes/desktop/desktopVoiceNotes";
import { installDebugLog } from "./lib/debugLog";
import { billingLinksAllowed } from "./lib/openManageStorage";
import { hideSdkPurchaseLinks } from "./lib/sdkPanelPurchaseLinks";
import { hydrateDurableKeys } from "./lib/durableKeys";
import { APP_LOCK_PREFS_KEY } from "./lib/appLock";
import { NATIVE_SESSION_KIND_KEY, NATIVE_SIGN_OUT_PENDING_KEY } from "./lib/openkeyNative";

// False on the web and in the desktop (Tauri) app; true only inside the TinyCloud Home mobile app.
const nativeShell = Capacitor.isNativePlatform();
registerDesktopVoiceNotes();

// <html data-platform> for platform-specific CSS; the size class and the theme
// stay current from here on (index.html's inline script set both before paint).
const platform = appPlatform();
const root = document.documentElement;
root.dataset.platform = platform;
if (platform === "ios") {
  // Measure UIKit's preferred body size before React mounts, including the
  // pre-sign-in recorder. The native active event also catches text-size
  // changes made in Control Center while the app remains foregrounded.
  const updateIOSBodyScale = () => {
    const bodyStyle = document.createElement("span");
    bodyStyle.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;font:-apple-system-body";
    document.body.append(bodyStyle);
    const bodySize = Number.parseFloat(getComputedStyle(bodyStyle).fontSize);
    setIOSDynamicTypeScale(root, bodySize);
    bodyStyle.remove();
  };
  updateIOSBodyScale();
  document.addEventListener("visibilitychange", updateIOSBodyScale);
  void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) updateIOSBodyScale();
  }).catch((error: unknown) => {
    console.error("[DynamicType] Could not listen for app resume", error);
  });
}
initSizeClass();
initTheme();
// The iOS and Android apps open no purchase page, including from the TinyCloud SDK's panel and toasts.
if (!billingLinksAllowed(platform)) hideSdkPurchaseLinks();

// Installable web app: registers the service worker on the web only — never in
// the Capacitor or Tauri shells, and not under `vite dev` unless VITE_PWA_DEV.
setupPwa({
  hasServiceWorker: "serviceWorker" in navigator,
  isCapacitorNative: nativeShell,
  isTauri: "__TAURI_INTERNALS__" in window,
  protocol: window.location.protocol,
  hostname: window.location.hostname,
  port: window.location.port,
  dev: import.meta.env.DEV,
  devEnabled: import.meta.env.VITE_PWA_DEV === "true",
});

registerWebCaptureEngine();

// tinycloud.chat serves this same build; its visitors move to home.tinycloud.xyz (path, query and #hash kept) once
// that origin serves this build, unless recordings saved only in this origin's storage would be left behind, or this
// page must finish here (originMove.ts `originMoveExemption`). Only that host reads anything here.
const originMove: Promise<OriginMoveDecision> = isLegacyOrigin(window.location)
  ? decideOriginMove({ location: window.location, opener: window.opener != null })
  : Promise.resolve({ kind: "stay" });

// Android WebView before 137 has no WebCrypto Ed25519, which sign-in needs. If the probe itself
// fails, WebCrypto is left exactly as the engine provides it and the app still starts.
void installEd25519Polyfill().catch((error: unknown) => {
  console.error(`[webcrypto] Ed25519 probe failed; WebCrypto left unchanged: ${error instanceof Error ? error.name : "unknown error"}`);
}).then(async () => {
  await installDebugLog();
  // The phone app's settings that outlive its WebView storage (durableKeys.ts), in place before anything reads
  // them. A local file read; the bound only keeps a stuck bridge from holding the app at a blank screen.
  await Promise.race([
    hydrateDurableKeys([APP_LOCK_PREFS_KEY, NATIVE_SESSION_KIND_KEY, NATIVE_SIGN_OUT_PENDING_KEY]),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  const move = await originMove;
  if (move.kind === "move") {
    clearMovedAnswers();
    window.location.replace(move.url);
    return;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RootErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<RootRoute />} />
            <Route path="/about" element={<AboutRedirect />} />
            <Route path="/chat/*" element={<CaptureEngineGate><App /></CaptureEngineGate>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          {/* Inside the router: the notice's counts link to the Library and the Recording tab. */}
          {move.kind === "hold" && <OriginMoveHold />}
        </BrowserRouter>
        <PwaPrompts />
      </RootErrorBoundary>
    </StrictMode>,
  );
});
