---
"@tinychat/frontend": patch
"exo-desktop": patch
---

Exo desktop: Pause no longer shows "Paused" before it completes, and Stop settles instead of hanging while preserving the recorded audio. A Stop timeout does not confirm microphone release; the microphone may remain in use until Exo restarts (TC-1158).
