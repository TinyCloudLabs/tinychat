---
"@tinychat/backend": patch
---

(TC-1047, TC-988) Calendar auto-join sends a meeting at its due time from a per-occurrence timer, instead of whenever the next worker tick (about 2 minutes on prod) reaches it; ticks remain the backstop. One occurrence's dispatch path (its reads, capture claims, the intent write and the post-send writes) runs at request lane priority. Each tick logs `code=tick_done` with its duration and tenant, row, scan and timer counts.
