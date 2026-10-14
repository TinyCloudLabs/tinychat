---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Deduplicate hosted AssemblyAI jobs by account and note ID with a durable server journal, atomic off-volume spool identity enrollment, and client claim and lookup reconciliation. Deploy the backend before or with the frontend. Hosted mode requires a persistent volume and a fresh-install environment ID for the first boot.
