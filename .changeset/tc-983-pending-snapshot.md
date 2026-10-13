---
"@tinychat/frontend": minor
---

Existing browser sync passes persist a metadata-only snapshot of backend-ingested and completed transcriber meetings that are still unreconciled or unsaved. Each source records `changed_at` for projection changes and `checked_at` for the last completed check; unchanged snapshots refresh `checked_at` at most hourly. The snapshot uses the retrieval pack's existing connector read grant. Pack consumption is intentionally deferred until TC-977 merges.
