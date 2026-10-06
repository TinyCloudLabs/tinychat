// Browser harness for test/connectors-scroll.e2e.test.ts: the REAL AppShell
// with the REAL surfaces (harness/ShellApp.tsx), at the address the test opens
// (/chat/connectors, /chat/capture, /chat/settings). Every backend call the
// cards make fails or finds nothing (the harness server answers /api/* with
// 401, and the empty-space stub answers TinyCloud), which leaves each card in
// its signed-in-but-empty state: Capture's Transcriber shows its Meeting bot /
// Upload audio tabs and the meeting-link form with its `sr-only` labels.
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { initSizeClass } from "../lib/sizeClass";
import { createRuntimeShim } from "../harness/runtimeShim";
import { ShellApp } from "../harness/ShellApp";

initSizeClass();
const shim = createRuntimeShim();

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <ShellApp platform="web" shim={shim} state="ready" />
  </BrowserRouter>,
);
