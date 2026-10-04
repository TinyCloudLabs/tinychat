---
"@tinychat/frontend": minor
---

Google Meet and Calendar autojoin can be connected from the Exo mobile app. Google refuses sign-in inside the app's web view, so on mobile "Continue with Google" opens the system browser (Custom Tabs on Android, Safari on iOS) and returns to Exo when you finish. The web app's popup flow is unchanged. The in-app flow ships switched off (build flag `VITE_EXO_NATIVE_GOOGLE_OAUTH`) until it can return through a verified https link; until then the app says that Google can be connected from the web.
