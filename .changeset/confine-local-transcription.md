---
"exo-desktop": patch
---

Confine desktop capture segments and on-device Whisper staging to vault sessions; the webview supplies identifiers, not audio paths or transcription URLs. Remove obsolete capture, transcription, device-state and model-download grants, deny menu/tray file-path icons and arbitrary image reads, and keep the release IPC permission gates. Unsafe stage cleanup no longer prevents deletion of a note's own audio.
