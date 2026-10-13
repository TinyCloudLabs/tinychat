---
"@tinychat/backend": patch
---

TC-1006: meetings, Send notetaker and calendar auto-join status no longer hang behind the auto-join worker on the shared backend storage lane. Request work now starts before queued worker work, and the worker still gets one slot after every 4 request jobs that overtake it. The worker's listings take one lane slot per row instead of holding the lane for the whole listing. Cached meetings-index reads skip the lane entirely. A request read that can't start within 12 s returns a retryable 503 instead of outwaiting the client. Lane waits of 1 s or more are now logged.
