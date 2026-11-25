---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

TinyChat uses the published TinyCloud SDK release 3.16.0 (web-sdk 3.16.0, node-sdk 3.16.0, web-sdk-wasm 1.8.0). Publishing an account's registry record follows the SDK: the wallet or OpenKey signature prompt is the consent, and the SDK publishes only from TinyCloud One and Home. Anywhere else the owner is sent to TinyCloud One to finish setup. The Home card for this step reads "Let your apps find your space" and has a Publish button. It stays hidden on a device once the button is tapped and returns after sign-out. The desktop app does not show it. Sign-in does not publish the record on its own.
