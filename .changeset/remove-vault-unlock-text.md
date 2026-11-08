---
"@tinychat/frontend": patch
---

Remove text and steps that claimed a secrets unlock or wallet signature that never happens. The secrets vault is network-encrypted, so reading it needs only the sign-in's decrypt permission; there was never a per-session vault signature. The Fireflies connect dialog no longer says TinyCloud will ask for a wallet signature. The "Upload paused · Continue to unlock it" state is gone: an interrupted upload resumes at launch, and an old own-key upload says to choose the file again, as it already did after Continue. In Settings, background notifications say to sign in instead of "Your keys are locked", without the Sync button that only ran the no-op unlock. About and the Calendar autojoin and server-side ingestion consent texts no longer mention unlocking. In the Exo app, disconnecting a connector whose saved key or Google connection isn't available there says to disconnect from Exo on the web or desktop. Linear: TC-2528
