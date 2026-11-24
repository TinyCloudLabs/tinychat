---
"@tinychat/backend": minor
"@tinychat/frontend": minor
---

TrustBot can answer agents that message its owner through Courier. Owners pair each agent in TrustBot's settings, and can unpair it there. TrustBot answers only with what the owner lets it read. It doesn't take requests or tasks over Courier.

TrustBot keeps Courier conversations encrypted. It keeps each message for up to 30 days, the latest 200 messages in each conversation and the 50 most recently active conversations, and deletes older ones. Owners can delete any of these conversations. What TrustBot reads to answer isn't kept, apart from what it writes in its answers.

Owners can keep any chat out of what TrustBot reads, from TrustBot's settings.

TrustBot can read the owner's Telegram chats that Inbox collects, when the owner turns on the Telegram read area.

Details: TC-4058
