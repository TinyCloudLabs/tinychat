---
"exo-desktop": patch
---

Exo desktop: enforce a production Content-Security-Policy in the webview (bundled scripts only, an explicit allowlist of the origins the app fetches, OpenKey as the only frame), replacing `csp: null`.
