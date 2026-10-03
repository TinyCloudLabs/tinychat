---
"@tinychat/frontend": minor
"@tinychat/backend": patch
---

Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.

- **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
- **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
- **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
- **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
- **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.
