---
"@tinychat/frontend": patch
---

An approval card may carry two optional fields: `redeemedAt` (when its grant was used) and `grantLifetime` (how long the access lasts: a whole number of hours or days, up to 30 days). Cards carrying them are now read, imported and archived instead of refused, and the card shows "Used …" and "Access lasts …".
