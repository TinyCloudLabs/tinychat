import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import "./index.css";
import { App } from "./App";
import { installEd25519Polyfill } from "./lib/ed25519Polyfill";
import { CaptureEngineGate } from "./capture/recorder/CaptureEngineGate";
import { PwaPrompts } from "./components/pwa-prompts";
import { RootRoute } from "./landing/RootRoute";
import { registerWebCaptureEngine } from "./lib/voiceNotes/web/registerWebEngine";
import { appPlatform } from "./lib/platform";
import { setupPwa } from "./lib/pwa";
import { initSizeClass } from "./lib/sizeClass";
import { initTheme } from "./lib/theme";
import { registerDesktopVoiceNotes } from "./lib/voiceNotes/desktop/desktopVoiceNotes";

// False on the web and in the desktop (Tauri) app; true only inside Exo mobile.
const nativeShell = Capacitor.isNativePlatform();
registerDesktopVoiceNotes();

// <html data-platform> for platform-specific CSS; the size class and the theme
// stay current from here on (index.html's inline script set both before paint).
document.documentElement.dataset.platform = appPlatform();
initSizeClass();
initTheme();

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

// Android WebView before 137 has no WebCrypto Ed25519, which sign-in needs. If the probe itself
// fails, WebCrypto is left exactly as the engine provides it and the app still starts.
void installEd25519Polyfill().catch((error: unknown) => {
  console.error(`[webcrypto] Ed25519 probe failed; WebCrypto left unchanged: ${error instanceof Error ? error.name : "unknown error"}`);
}).then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRoute nativeShell={nativeShell} />} />
          <Route path="/chat/*" element={<CaptureEngineGate><App /></CaptureEngineGate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <PwaPrompts />
    </StrictMode>,
  );
});
