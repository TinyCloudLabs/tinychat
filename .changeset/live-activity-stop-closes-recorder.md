---
"@tinychat/frontend": patch
---

Stopping a recording from outside the app now closes the recorder. This covers the Live Activity's Stop on the Lock Screen or Dynamic Island, "Stop recording" from Siri or Shortcuts, and the Android notification's Stop or Discard. Before, the note was saved but the recorder stayed on "Finishing…" with its clock running and every button greyed out, and only a relaunch cleared it. Now the recorder shows the saved note, like its own Done. When the app comes back to the foreground, it also checks with the phone what is really recording.

Details: TC-3118
