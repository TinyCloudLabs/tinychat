---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

The phone apps now serve their bundled web app from their own origin: `https://app.tinycloud.one` on Android and `tinycloudone://app.tinycloud.one` on iOS, in place of Capacitor's shared `https://localhost` and `capacitor://localhost`. The backend accepts both the new and the old origins until the new-origin tester builds are out (removal: TC-3046). Updating the app moves it to a new WebView origin: the backend session restores from the device's secure store, and the app-lock settings and sign-in records come from native storage. Details: TC-3045.
