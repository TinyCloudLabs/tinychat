---
"@tinychat/backend": patch
---

Google connections started on tinycloud.one return to tinycloud.one. The backend accepts two new `state` tags, `one.<nonce>` for the popup return and `onetab.<path>.<nonce>` for the same-tab return; both go to the fixed https://tinycloud.one origin when it is in the `FRONTEND_ORIGINS` allowlist (it is by default), and are refused like any unknown tag when it is not. Untagged, `tab.`, `home.`, `hometab.` and `native.` flows are unchanged.
