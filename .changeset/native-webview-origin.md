---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

The phone apps now serve their bundled web app from their own origin: `https://app.tinycloud.one` on Android and `tinycloudone://app.tinycloud.one` on iOS, in place of Capacitor's shared `https://localhost` and `capacitor://localhost`. The backend accepts both the new and the old origins until the new-origin tester builds are out (removal: TC-3046). Updating the app moves it to a new WebView origin: the backend session restores from the device's secure store, and the app-lock settings and sign-in records come from native storage. On the first launch after the update the app copies what it kept only on the phone from the old origin (unsent Home answers and drafts, recording notes, held transcripts, transcription jobs and choices, recording, theme and view settings), keeping anything already at the new origin; only after that copy is in does it delete the old origin's data, once. Sign-in keys and tokens are never copied. The recording settings also come back from the recorder when the WebView has none. Details: TC-3045.
