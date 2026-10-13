---
"@tinychat/frontend": minor
---

Existing browser sync passes persist a metadata-only snapshot of backend-ingested and completed transcriber meetings that are still unreconciled or unsaved. `changed_at` records projection changes; `checked_at` is the observation time of the last persisted source check. Backend-ingest updates on existing mount/unlock passes only. Transcriber unchanged projections refresh at most hourly on its existing 30-second active/unlocked pass, so its consumer freshness threshold must exceed 1 hour plus 30 seconds. The snapshot uses the retrieval pack's existing connector read grant. Pack consumption is intentionally deferred until TC-977 merges.
