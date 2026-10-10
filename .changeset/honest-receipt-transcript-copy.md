---
"@tinychat/frontend": patch
---

The Done receipt is honest about a Local note: the source reads "This phone" until a transcript exists, "Saved on this phone" is said once, the gap above the receipt is gone, and a note waiting on the model shows a static "Needs the on-device model" with "Get model" and "Use Private instead" (no spinner), kept open for 10 seconds while there is something to press. A saved note's transcript block is one sentence ("Transcribe on this phone — needs a 640 MB download") with a full-width button, and offers "Transcribe with Private instead" when Private is available. Switching to Private waits until the phone's own record says the on-device job has ended (and never starts Private if Local finished first), a Private choice survives a restart, the receipt says "Transcribing" only while a private job is really running (Audio only says nothing; finished and failed Private notes say so), and a receipt with Open stays 10 seconds.
