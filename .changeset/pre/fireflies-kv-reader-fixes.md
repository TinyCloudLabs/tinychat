---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Restrict MCP Fireflies KV fallback to proven-absent SQL stores, filter and revalidate cached server-imported Library rows against the active flag and purge ledger, align Library KV paging with `nextCursor` and `truncated` and update the MCP KV truncation text.

Details: TC-3919
