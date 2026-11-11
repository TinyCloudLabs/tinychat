---
"@tinychat/frontend": patch
---

Native sign-in on iOS and Android asks for every applications-space KV, SQL and hook entry of the manifest, the same grant as the web sign-in, so the Home feed works on the phone apps (TC-2720). Space info stays web-only until the backend accepts it. A CI job checks the native request against production OpenKey's ceiling.
