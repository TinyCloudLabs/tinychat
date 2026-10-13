---
"@tinychat/backend": patch
---

TC-1006: meetings, Send notetaker and calendar auto-join actions no longer hang behind the auto-join worker on the shared backend storage lane. Request work now starts before queued worker work, and the worker still gets one slot after every 4 request jobs that overtake it. The worker's listings take one lane slot per row instead of holding the lane for the whole listing. Cached meetings-index reads skip the lane entirely. A request lane job that can't start within 12 s returns a retryable 503 instead of outwaiting the client. Lane waits of 1 s or more are now logged.

Known limitation: the Connectors auto-join status read is bounded by one 12 s deadline for the whole read. For an account with more than about 6 auto-join rows (for example, many unaccepted invites in the last 30 days), it now answers 503 after about 12 s on every call instead of hanging. The same applies to the status returned after a successful enable or disable, whose change still lands. A capped or cached outcome listing is the follow-up.
