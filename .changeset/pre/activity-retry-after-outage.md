---
"@tinychat/frontend": patch
---

After your TinyCloud space has been unreachable, no Activity line says "Needs attention" without a way to act on it. A transcript that is already saved in your space shows nothing when the app cannot check it there; the app checks again by itself. A transcript the app could not write to your space has Try again, which writes the transcript already on your device and never transcribes the note again. Such a write is also tried again by itself while you are signed in, and shows as Retrying with Try now until your space takes it. While a save is waiting for its next try, its audio upload line no longer says "Needs attention".
