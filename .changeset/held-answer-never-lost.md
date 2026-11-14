---
"@tinychat/frontend": patch
---

Feed: an answer you gave just as you left the app is never lost silently. When you come back, the card says "Not sent" with your answer if the card has changed or closed, even if you had it open when it changed; an answer you wrote in words is shown in the line so you can say it again. If the app could not reach the server, the card says the answer isn't sent yet and it goes the next time you open the app. If the agent is no longer connected, a notice says so until you dismiss it. If you leave before you have seen any of these, they appear the next time you open the feed.
