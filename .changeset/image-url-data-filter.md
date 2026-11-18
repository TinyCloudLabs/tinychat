---
"@tinychat/frontend": patch
---

An image in a chat reply or a note loads as before unless its address looks like it carries data out: an encoded run that decodes to text, a long opaque blob, data in the host name, an IP address or local host, credentials, a redirect to another address, an email address or a key, and similar signs, each weighted. An image whose signs add up asks "Load image from <host>?" with the full address first; ordinary CDN addresses (hashed file names, signed S3 links, image proxies) load. Images with a data:, blob: or other non-web address never load. Links in replies and notes send no referrer.
