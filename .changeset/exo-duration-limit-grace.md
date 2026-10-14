---
"@tinychat/backend": patch
"@tinychat/frontend": patch
"exo-desktop": patch
---

Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. No Private limit is hard-coded; without an advertised limit Private is not offered and the note says Private's limits aren't available right now. The backend relays the optional fields when PTX sends them; a client-only deploy is safe.
