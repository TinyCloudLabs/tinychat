---
"@tinychat/frontend": patch
---

Add the recorder engine seam: one selector installs the native, web or desktop engine at boot (web and desktop only with the final recorder on), and native-only calls are gated on the engine's capabilities.
