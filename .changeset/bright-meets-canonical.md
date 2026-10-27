---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Normalize Google Meet invite links using `meet.google.com/meet/<code>` to the canonical `meet.google.com/<code>` URL before they are validated or sent to the notetaker. Preserve query strings and fragments.
