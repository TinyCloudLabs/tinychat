---
"@tinychat/frontend": patch
---

Stopping a recording from outside the app closes the recorder and shows the saved note, like its own Done. This covers the Live Activity's Stop on the Lock Screen or Dynamic Island, "Stop recording" from Siri or Shortcuts and the Android notification's Stop or Discard. When the app comes back to the foreground, it checks with the phone whether the recording on screen is still running.

Details: TC-3118
