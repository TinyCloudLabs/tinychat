---
"@tinychat/backend": patch
---

The backend does not fetch or store Fireflies meetings itself. It holds no Fireflies sign-in and keeps no copy of any meeting, and the switch, keys and routes for that path are gone from the code, the deploy files and the example settings. Fireflies meetings sync in the browser, and webhook deliveries wait in the queue for the browser to collect. Production never turned the backend path on, so no stored meeting is affected.

Details: TC-1964
