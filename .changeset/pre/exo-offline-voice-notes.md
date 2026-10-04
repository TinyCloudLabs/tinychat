---
"@tinychat/frontend": minor
---

Exo mobile: record voice notes when Exo can't connect, and they are saved once it reconnects.

- **Record from the offline screen.** If Exo launches without a connection but your session is still held ("You're offline…" or "Can't reach Exo right now. You're still signed in."), that screen now has a voice recorder. It shows the elapsed time, the level and the same microphone warnings as the Voice notes card. Stop keeps the note on the phone, and the screen counts what is waiting: "2 notes will be saved when you're back online." The recorder stays on screen through "Try again". It is not offered when you are signed out, because there is no account to save to.
- **Saved when the session is back.** Once Exo is signed in again, notes still on the phone (recorded offline, or from a save that failed) are saved to your TinyCloud space right away, without opening Connectors. When private-cloud transcription is on, they are queued for it just like notes saved from the card. This uses the card's own retry, so a note is never uploaded twice.
- **A recording that is still running carries over.** If Exo reconnects while you are recording, the chat screen's voice note bar shows that recording and its Stop. The recording is never restarted.
