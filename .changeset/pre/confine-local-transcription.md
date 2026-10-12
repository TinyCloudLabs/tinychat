---
"exo-desktop": patch
---

Confine desktop capture and on-device Whisper to vault sessions and identifiers supplied by the webview. Remove main's unrestricted transcription-start permission and core menu/tray defaults, deny image file-path reads, and enforce the release IPC permission gate. Guard Whisper stage cleanup against concurrent staging and recover orphaned note copies.
