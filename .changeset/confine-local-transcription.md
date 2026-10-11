---
"exo-desktop": patch
---

Confine both the shared desktop recorder's capture segments and on-device Whisper staging to the current vault's sessions tree. The webview supplies identifiers only: native code reserves fresh session folders, forces batch capture and validates its own loopback Whisper server before transcription. Revoke the transcription plugin's unrestricted start grants and arbitrary image-path reads; keep the release IPC permission self-test and generated-permission gate.
