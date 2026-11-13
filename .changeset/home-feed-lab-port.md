---
"@tinychat/frontend": minor
---

Home Feed gets the new card design.

- **Views:** an Information | All | Needs action slider stays in reach as you scroll. "View" shows cards Compact (the default), as Full cards, or as a Grid, and keeps your place when you switch. History, Snoozed, priority and order sit under Filter.
- **Compact cards:** each shows the agent, a relative time, where the card stands, a P0/P1 priority mark, when it's due, and how many times the agent replied.
- **Open cards:** a card can carry a one-page brief that opens in the app. Comments read as a conversation. A comment shows "Received" only once the agent confirms it, and offers "Send again" if it isn't confirmed within two minutes.
- **5 s Undo on every send:** that covers answers, comments, approvals, codes, and claim and task actions. A go is checked again before it's sent, and an approval that expired or closed in the meantime sends nothing.
- **Card actions:** a decision can be dropped and an update acknowledged; either can be asked about later. Each takes the card away at once with Undo at the bottom of the screen, then tells the agent, and the card moves to History marked Dropped, Acknowledged or Expired.
- **Posts:** a post opens as a page with media and questions. Answers go to the agent per question, and unsent answers stay on the device.
