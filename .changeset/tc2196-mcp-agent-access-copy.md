---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Settings > Agent access now says "Lets the agent read your meeting transcripts and remember things between chats. Public web search works without it." For accounts served by the MCP, which cannot revoke a grant, the card hides the Disconnect and Retry disconnect buttons and says "This access ends 30 days after you connected." while connected. The meeting message shown when access changes mid-request now reads "Reconnect the agent in Settings > Agent access." Details: TC-2196
