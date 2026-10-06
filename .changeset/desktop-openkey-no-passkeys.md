---
"@tinychat/frontend": patch
---

Exo desktop no longer offers passkeys in the OpenKey sign-in modal. WebAuthn does not work in the ad-hoc-signed Tauri webview, so the desktop shell opens OpenKey with `passkeysSupported: false` (sign-in, sign-out and Connect agent), and OpenKey offers only email and Google. The Connect agent banner on desktop now says you'll sign in with OpenKey instead of promising a passkey. Web and mobile are unchanged. Requires `@openkey/sdk` 0.11.0.
