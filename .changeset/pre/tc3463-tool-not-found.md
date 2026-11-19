---
"@tinychat/backend": patch
---

Recover when the model calls a tool the turn did not offer (TC-3463). On a public-only turn, a call to any tool but `web_search` (native or inline markup) now gets a `tool_not_found` tool result instead of failing the reply with `routing_mismatch`: nothing is dispatched, no tool activity is shown, and the model answers on its next round. A model that keeps calling unoffered tools until its rounds run out still fails with `routing_mismatch` (model-caused, charged).
