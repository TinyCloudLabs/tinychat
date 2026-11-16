---
"@tinychat/frontend": minor
---

Settings → Account has "Delete OpenKey account" (TC-2721, App Store 5.1.1(v)). It opens OpenKey's deletion page, `https://openkey.so/dashboard/settings/delete-account` on the configured `VITE_OPENKEY_HOST`, in the system browser sheet on the phone or a new tab on the web. The row isn't shown on desktop, which has no fixed-URL opener for it yet.
