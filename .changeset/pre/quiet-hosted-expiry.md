---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
