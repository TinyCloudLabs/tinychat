---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

The main bot's questions and requests are on by default, so it can ask the owner a question, request a secret and propose actions. Each one reaches the owner as a card to approve or decline. An owner who turns them off keeps them off, even after the bot's working state is deleted, and a damaged setting file reads as off.

Details: TC-4330
