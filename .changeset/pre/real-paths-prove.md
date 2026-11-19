---
"@tinychat/frontend": patch
---

One Apps behind VITE_ONE_APPS (off in production): TinyCloud's own apps open inside One with the access they need from One's session, asking first when an app wants more. Also fixes `vite dev` pages crashing on start; production builds are unchanged.

Details: TC-3337
