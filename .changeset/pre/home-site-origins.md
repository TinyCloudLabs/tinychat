---
"@tinychat/backend": minor
---

Adds https://home.tinycloud.xyz to the allowed web origins: CORS, the SIWE sign-in domain (signed like the production web domain), and the Google OAuth return. The OAuth `state` accepts two new tags, `home.<nonce>` for the popup return and `hometab.<path>.<nonce>` for the same-tab return; both go to the fixed Home origin. Untagged, `tab.` and `native.` flows are unchanged. Details: TC-2387
