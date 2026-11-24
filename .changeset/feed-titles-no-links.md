---
"@tinychat/frontend": patch
---

Home feed card titles hide links and tokens. A link in a title shows as "[link]". A bearer token, a JWT or a long hex or base64 string shows as "[hidden]". A message relayed over Courier is titled by a short summary of its first line, or "New message" when that line held only links or tokens. This applies to titles only.

Details: TC-4253
