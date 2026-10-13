---
"@tinychat/frontend": patch
---

Existing browser sync passes now persist a metadata-only snapshot of backend-ingested and completed transcriber meetings that are still unreconciled or unsaved. The snapshot is written under the retrieval pack's existing connector read grant and only when the projection changes. Pack consumption is intentionally deferred until TC-977 merges.
