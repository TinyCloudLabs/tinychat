---
"@tinychat/frontend": patch
---

TinyCloud Transcriber sync shares each saved meeting it confirms with your other open tabs as it goes, so if the syncing tab closes partway through, the next one picks up where it stopped. A meeting whose saved copy can't be read is never treated as confirmed, and a meeting removed from your space is checked again if it comes back.
