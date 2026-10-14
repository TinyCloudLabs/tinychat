---
"@tinychat/backend": patch
---

Give each signed-in user their own rate-limit buckets. Every bucket is now keyed by the verified session address, not the client IP: in production the IP is the Phala gateway's for every client. Signed-in users get the pre-incident per-user ceilings (for example global 120 and paid chat 120 per 15 minutes). Requests without a valid session share one anonymous bucket at the 0.5.4 whole-service ceilings.

The 0.5.4 ceilings stay in force as aggregates over all users for paid chat (600), private cloud job changes (300) and hosted uploads, so fresh wallets can't multiply them. Sign-in (`/api/auth`) has one bucket of 1,200 per 15 minutes whatever bearer a request carries, which bounds session minting. `X-Forwarded-For` no longer affects any rate-limit key.
