---
"@tinychat/frontend": patch
---

One Apps host behind VITE_ONE_APPS (off in production): TinyCloud apps framed in One with silent, scoped, per-space delegations, an ask card and OpenKey step-up, and Monica's copy for spaces that aren't set up. Also fixes `vite dev` crashing on every page load (the polyfill shim's pre-bundled CommonJS build imported itself); production builds are unchanged. Details: TC-3337
