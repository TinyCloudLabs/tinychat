---
"@tinychat/frontend": patch
---

After your TinyCloud space has been unreachable, no Activity line says "Needs attention" without a way to act on it. A transcript the app could not write to your space, or could not check there, has Try again, which writes the transcript already on your device and never transcribes the note again. Such a write is also tried again by itself while you are signed in, and shows as Retrying with Try now until your space takes it. While a save is waiting for its next try, its audio upload line no longer says "Needs attention".
