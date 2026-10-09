---
"@tinychat/frontend": patch
---

Recorder (final, phone, behind `VITE_EXO_RECORDER_FINAL`): note moments with ＋ while recording, and a notes sheet with a Markdown writer and a lazily loaded Markdown preview (TC-881). The preview's WASM is no longer part of the service worker's install; it is cached after its first use.
