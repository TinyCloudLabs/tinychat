---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

The secret guard now checks a link the way a browser opens it, so a one-tap approval link written with a default port, dot segments, backslashes, a look-alike dot or a tab inside it is refused like the plain link.
