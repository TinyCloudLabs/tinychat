---
"@tinychat/frontend": patch
---

Home now checks every card it shows for secrets and approval links, not only the cards it writes. A card from a connected agent that carries a one-tap approval link, a key or a credential is shown without its links, options or approval button. Details: TC-3236.
