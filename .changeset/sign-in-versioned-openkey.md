---
"@tinychat/frontend": patch
---

On the web and in the desktop app, signing in, re-authorizing Connectors and connecting an agent now go through OpenKey's permission review (the screen that lists what TinyCloud One asks for and has an Approve button) instead of asking the owner to sign a raw message. It is still one approval, and the permissions and their 30-day length are unchanged.

If the owner unticks permissions in that review, sign-in is refused and the message says which permissions TinyCloud One needs and how to try again, instead of a generic failure. The Connectors permission prompt and connecting an agent do the same.
