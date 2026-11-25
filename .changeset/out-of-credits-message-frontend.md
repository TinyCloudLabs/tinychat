---
"@tinychat/frontend": patch
---

When a message gets no reply because the account is out of credits, the chat says so: "You're out of credits on the Free plan, so this message got no reply and nothing was charged." When the billing status has the reset time, the message also says when credits reset. Without the plan name it says "your plan". A reply that was partly written keeps the existing limit text. The pricing dialog opens for plans that have an upgrade and stays closed on the top plan.

Details: TC-4312
