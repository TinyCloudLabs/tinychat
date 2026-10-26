---
"@tinychat/frontend": patch
---

The one-time automatic re-submit of provider-failed voice notes now runs strictly one note at a time, and a note whose attempt is refused because the account already has an active transcription is not counted as used: it is tried again on the next load.

Details: TC-2085
