---
"@tinychat/backend": patch
---

Private transcription can tell apart the people on the other side of a two-channel recording, for the accounts an operator lists. It is off unless `PRIVATE_STEREO_SPEAKERS_ENABLED` is `true` and `PRIVATE_STEREO_SPEAKERS_TEST_ACCOUNTS` names the accounts (`*` for everyone); with either unset nothing changes.
