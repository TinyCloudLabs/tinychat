---
"@tinychat/frontend": patch
---

An image in a chat reply or a note loads as before unless its address looks like it carries data (a long query string or path segment, many parameters, an encoded run, or words joined by separators). That image asks "Load image from <host>?" with the full address first; images with a data:, blob: or other non-web address never load. Links in replies and notes send no referrer.
