---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

TC-3136: removing a notetaker recording now deletes the capture provider's copy (audio, video, transcript and derived artifacts) and only counts it as gone after reading it back not-found. A delete that cannot be confirmed yet stays listed as "deleting" and is retried with backoff, never dropped. Settings → Account gains "Delete my recordings first", a bulk `DELETE /api/transcriber/meetings`, ahead of deleting the OpenKey account. A recording shared with you is only removed from your list. A recording the notetaker service cannot attribute to you is removed from your list but not deleted there, and says so on its row.
