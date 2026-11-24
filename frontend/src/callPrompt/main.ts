// Entry of the "Record this call" tile (frontend/call-prompt.html, Tauri window `call-prompt`). Imports only the
// Tauri core and event modules, which are their own chunk (vite.config.ts manualChunks): never the app's entry chunk.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mountCallPromptTile } from "./tile";
import "./callPrompt.css";
import "./page.css";

// No context menu: the tile has nothing to copy, and the web view's own menu offers Reload.
document.addEventListener("contextmenu", (event) => event.preventDefault());

const root = document.getElementById("call-prompt");
if (root) mountCallPromptTile(root, { invoke: (command) => invoke(command), listen });
