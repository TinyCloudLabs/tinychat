---
"@tinychat/frontend": minor
---

Exo mobile voice notes can be transcribed with private cloud transcription (TinyCloud Private Transcription → Tinfoil), the same path as the desktop's Exo Local engine. It is offered only when the build has a PTX upload origin, the device can upload (iOS, or Android 8.0 and later), and the backend admits the account. The user confirms "Use private cloud" once, and the choice is kept per account. New notes are transcribed after they are saved, and older ones have a Transcribe action. The card shows progress, failures with Retry, and the transcript. "Turn off" stops anything not yet sent.

Transcribed voice notes appear in Library and in meeting chat. A voice note that is not transcribed is not a meeting, so it never wins "my latest meeting". Exo desktop's private cloud recovery no longer adopts a phone's voice-note job: it recovers only jobs it made itself.
