---
"@tinychat/frontend": patch
---

On-device transcription no longer freezes the app: the iOS queue answers status and cancel while a note decodes, installed models are verified in the background (reported as "checking"), and cancel, retry and model-load races leave a note in one consistent final state.
