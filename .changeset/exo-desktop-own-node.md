---
"@tinychat/frontend": minor
"exo-desktop": minor
---

Add a "Your own node" setting to the desktop app: a node address (`http://127.0.0.1:<port>` only) read once at startup, with "Use the default" to go back. Changing it signs out and reloads. The app asks the node for its ID (`GET /info`) before every sign-in and on restore, asks you to confirm it the first time, and refuses with an explanation if a different node answers later; "Forget saved node ID" resets it. While your own node is set, features that need Exo's online service (meeting services, agent access, the meeting notetaker) are off, each with a line linking to the setting. The desktop content security policy allows `connect-src http://127.0.0.1:*` and nothing else new. The default is unchanged. Details: TC-1769
