---
"@tinychat/frontend": patch
---

A sitrep card may carry an optional `post`: one line of up to 280 characters, for a card to lead with. Cards with a `post` are now read, imported and archived; a `post` that is empty, over 280 characters or contains a control character other than a newline is refused.
