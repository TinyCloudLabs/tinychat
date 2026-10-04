import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Capacitor } from "@capacitor/core";
import "./index.css";
import { App } from "./App";
import { RootRoute } from "./landing/RootRoute";

// False on the web and in the desktop (Tauri) app; true only inside Exo mobile.
const nativeShell = Capacitor.isNativePlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRoute nativeShell={nativeShell} />} />
        <Route path="/chat/*" element={<App />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
