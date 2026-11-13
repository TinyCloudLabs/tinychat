---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Disconnect agent now works for accounts served by the MCP. The browser revokes, from the owner's own session, every active grant the owner gave the MCP service DID over the TinyChat connectors data (other apps' grants are left alone), then reads the status back from the MCP and shows Disconnected only once the MCP can no longer use the grant; a failed revoke keeps the existing "Disconnection was not confirmed" state. The backend now reads a grant the owner revoked on the node (the MCP answers AUTH_REQUIRED with reason delegation_revoked or delegation_ancestor_revoked) as "not connected" instead of failing the session status with 502. Settings > Agent access now says "Lets the agent read your meeting transcripts and remember things between chats. Public web search works without it." The meeting message shown when access changes mid-request now reads "Reconnect the agent in Settings > Agent access." Details: TC-2196
