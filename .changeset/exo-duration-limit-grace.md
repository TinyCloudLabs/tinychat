---
"@tinychat/backend": patch
"@tinychat/frontend": patch
"exo-desktop": patch
---

Fix the Private transcription length boundary. Eligibility now compares the unrounded note length with the limit PTX advertises in `/capabilities`: `accepted_max_duration_seconds` when present, otherwise `max_duration_seconds`, plus the optional `duration_grace_seconds`. No Private limit is hard-coded; if PTX advertises no duration limit, Private is not offered and the note says Private's limits aren't available. Rejection copy shows precise durations. The backend relays the two optional fields when PTX sends them, so this needs a backend deploy for the new fields to reach clients; a client-only deploy is safe.
