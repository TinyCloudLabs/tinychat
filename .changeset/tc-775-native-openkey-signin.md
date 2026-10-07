---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

Native OpenKey sign-in for the Exo app (TC-775 E1, behind `VITE_EXO_NATIVE_OPENKEY`). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected. The flag stays off in every build until the OpenKey server side and the registered native client ship.
