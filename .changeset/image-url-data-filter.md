---
"@tinychat/frontend": patch
---

An image in a chat reply or a note loads as before unless its address looks like it carries data out: an encoded run that decodes to text, a long opaque blob, data in the host name, an IP address or local host, credentials, a redirect to another address, an email address or a key, and similar signs, each weighted. An image whose signs add up asks "Load image from <host>?" with the full address first; ordinary CDN addresses (hashed file names, signed S3 links, image proxies) load. Whatever an address looks like, it also asks when it has room for more than 1,536 bits of data, and the images of one reply or note load on their own only while their addresses together have room for no more than 8,192 bits; the rest wait behind one prompt. In a chat reply, images appear when the reply has finished streaming. Images with a data:, blob: or other non-web address never load. Links in replies and notes send no referrer.
