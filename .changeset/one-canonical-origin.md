---
"@tinychat/frontend": minor
---

tinycloud.one is the canonical address. Visitors on tinycloud.chat or home.tinycloud.xyz move to tinycloud.one once nothing is left only in their browser; anyone with recordings or answers still on the old address stays there, with a notice, until they are saved or sent. Opening the old address with `?legacy=1` keeps the app there so that data can be saved. Each release now checks that all three addresses serve it. Details: TC-3108.

Device preferences (theme, notes view, capture preferences and consents) are kept per address, so they start fresh on tinycloud.one. Settings on tinycloud.one links to the old addresses for anything left there, and a page still holding unsaved text, an unsaved title or an answer waiting out its undo window does not move until that is done.
