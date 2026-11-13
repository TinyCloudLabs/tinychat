---
"@tinychat/frontend": patch
---

Playback diagnostics (TC-2857): an opt-in, on-device log of how a note's audio plays, for diagnosing choppy playback. Off by default; Settings reveals it after seven taps on the build line. It records the iOS audio session (category, mode, route, interruptions, thermal state, Low Power Mode), the note player's events and its clock against the wall clock, the audio source type and size, and main-thread blocks during playback, and exports as JSON lines with Share or Copy. No note content or file path is recorded.
