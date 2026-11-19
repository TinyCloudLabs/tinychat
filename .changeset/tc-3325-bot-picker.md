---
"@tinychat/frontend": patch
---

Settings has a "Chat view" card to choose Classic or Bots; Classic stays the default, and Bots can be picked only by an account that is let into bots. With Bots, your bots are listed under Chat in the sidebar, as avatars on the rail and in a strip above the chat on a phone, each at its own address (`/chat/bot/<key>`), and Chat opens the bot you had open last. "New bot" opens the create dialog and is turned off, with the reason, once the account has as many bots as it can have.

Details: TC-3325
