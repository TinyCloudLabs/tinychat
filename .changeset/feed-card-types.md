---
"@tinychat/frontend": minor
---

Feed: a card can say what kind of task it is, and a message from another team over Courier is marked. An agent sets `payload.type` to one of Spend, Publish, Send, Access, Rule, Ship, Do, Review, Direction, Answer, News or Alert, and the word shows at the top right of the card's row and beside the title of the open card. Spend, Publish, Send and Access, where your tap sends something out, are outlined with an arrow; Alert is in the warning colour; the rest are grey. A card with `payload.channel: "courier"` starts its name line with a Courier mark and its sender (`payload.source.label`); the open card adds, smaller, "via" the agent that passed it on. Filter offers "Task type" when any card has one. A type or channel the app doesn't know changes nothing on the card and is listed in Details as not shown.
