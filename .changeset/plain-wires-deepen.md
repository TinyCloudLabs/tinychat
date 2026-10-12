---
"@tinychat/frontend": minor
---

Native OpenKey sign-in (TC-775) is now the only sign-in path on iOS and Android — the `VITE_EXO_NATIVE_OPENKEY` build flag is gone, and so is the embedded-widget fallback on those two platforms. A widget session persisted on a device from before this change is cleared once on the next launch; the user signs in again through the native flow. Web and the Tauri desktop app are unchanged and keep the embedded widget. The registered native OpenKey client id is now committed config (`frontend/.env.production`), not something a build flag gated.
