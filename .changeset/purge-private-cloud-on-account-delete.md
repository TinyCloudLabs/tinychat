---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

TC-3166: "Delete my recordings first" (the bulk `DELETE /api/transcriber/meetings`) now also deletes the account's private cloud transcription jobs, so voice notes and uploads left behind by a failed or cancelled run are cleared on account deletion. Queued or running jobs are cancelled, transcripts are deleted, and the call only succeeds once TinyCloud Private Transcription's own list for the account is empty; otherwise it is a 503 and safe to retry. The response gains `privateCloudDeleted` (a count, or `null` when private cloud transcription is not used), which the step requires, so an older backend can never produce a "deleted" claim for voice notes and uploads; with `null` the step says nothing about them. The bulk delete is also mounted when private cloud transcription is on and the meeting transcriber is off. The step's wording now covers voice notes and uploads.
