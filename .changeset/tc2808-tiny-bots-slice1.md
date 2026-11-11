---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

Tiny bots, slice 1 (TC-2808), off by default. For accounts on `BOTS_TEST_ACCOUNTS` with `BOTS_ENABLED=true`, Home shows a "What do you want done?" box that sends to Main, the owner's main bot, and opens Main's chat with the reply streaming in. The backend adds `/api/bots/status` and `/api/bots/main/messages`, which forward to the new bots service (`bots/`). Everyone else sees no change.
