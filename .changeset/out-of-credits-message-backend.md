---
"@tinychat/backend": patch
---

When a chat message is refused before any model call because the account has no credits left, the answer says "You're out of credits on the {plan} plan, so this message got no reply and nothing was charged.", using the account's plan name.

Details: TC-4312
