---
"@tinychat/backend": patch
---

The agent session check waits up to 8 seconds for the MCP before it answers 502 mcp_unavailable, and logs the error code, the upstream HTTP status and the elapsed milliseconds when it fails, so the cause of that answer can be read in the logs.

Details: TC-3739
