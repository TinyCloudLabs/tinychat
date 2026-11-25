---
"exo-desktop": patch
---

The Mac app gets the native half of "who spoke when". In a Google Meet call with three or more tiles, while a recording of both sides runs and the "names in the call" setting is on, the app follows the speaking marker in each participant's tile through macOS Accessibility, five times a second, and keeps a timeline of who spoke when on this Mac. The timeline holds person ids and times only: no names, no captions, no page classes. The transcription reads it through a new command, `call_names_speaking_read`. Saving the note keeps it for a new transcription; deleting the recording's audio removes it, and so does the 30-day tidy. Sampling never delays a recording: it stops while the capture is paused, slows down when the browser answers slowly, and drops anything it cannot read. The app never acts on the meeting window.
