---
"@tinychat/frontend": minor
---

Add the owner Home feed over registered SQLite output/response pairs, with typed ask, task, approval, incident, work, ship, order, claim, hold and progress cards. Preserve exact issuance-bound drafts and private approval payloads; keep owner state, archive history, scoped priorities, answer persistence, delivery acknowledgement and outcomes distinct.

Adopt the published TinyCloud SDK 3.8.0-beta.22 history and response APIs with explicit frontend and relay dependencies. Remove the obsolete Node SDK beta.13 session-key patch because the published beta.22 artifacts contain the same fix.

Add the owner-operated same-UUID sitrep mirror adapter and gated relay. Closing responses require a verified conditional mirror close before an external handoff; uncertain handoffs are not automatically repeated. Owner provisioning, relay configuration, signed-in acceptance and production deployment remain separate operations. No storage fence, watcher exclusion or exactly-once guarantee is added.

Details: TC-2204
