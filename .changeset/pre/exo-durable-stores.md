---
"@tinychat/backend": patch
---

With `EXO_CAPABILITIES_ENABLED` set to `true`, the Exo mailbox now runs on real stores. Cooldown, daily-count, and active-run state is kept in the backend KV with compare-and-set writes. Queued wakes drain on shutdown, expired job mirrors are swept hourly, and owner and source Exo state is cleared on grant revoke, transcript delegation revoke, calendar autojoin disconnect, and connector teardown. The flag remains off by default.
