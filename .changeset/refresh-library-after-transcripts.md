---
"exo-desktop": patch
"@tinychat/frontend": patch
---

Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker import, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.
