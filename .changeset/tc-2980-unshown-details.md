---
"@tinychat/frontend": patch
---

Feed: every open card shows what it doesn't draw. "Details" in the card's foot carries a "+N" when the card holds data the card doesn't show. Details now unfolds inside the card and lists those fields under "Not shown on the card", exactly as the agent sent them (as text: links aren't opened and images aren't loaded), along with the card's facts, its history, and the whole card as sent ("Card data", with Copy). A Rocinante card the app can't read now points to Details, which lists everything it carries, instead of only "Ask your agent about this card."
