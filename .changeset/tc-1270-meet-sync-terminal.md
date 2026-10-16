---
"@tinychat/frontend": patch
---

Show a bounded Finishing phase while Google Meet sync reconciles Notes and saves its final state. Surface finalization failures with in-dialog Retry, preserving saved meetings and preventing late completion from an abandoned attempt. Refresh the connector row once for both owned and joined syncs.

This fixes the dialog getting stuck; it does not fix slow storage responses, so a slow sync may now end with an error and a Retry button instead of hanging.
