---
"@tinychat/backend": patch
---

Give each signed-in user their own rate-limit buckets. Every bucket is now keyed by the verified session address, not the client IP: in production the IP is the Phala gateway's for every client. Signed-in users get the pre-incident per-user ceilings (for example global 120 and paid chat 120 per 15 minutes). Requests without a valid session share one anonymous bucket at the 0.5.4 whole-service ceilings. `X-Forwarded-For` no longer affects any rate-limit key.
