---
"@tinychat/frontend": patch
---

Keep the Soft-skin recorder out of the flag-off web bundle and PWA precache: the Tauri engine registers through a lazy shim, the recorder flag is folded at build time, and final-only chunks (`final-*`) are precached only when VITE_EXO_RECORDER_FINAL is on.
