---
"@tinychat/frontend": patch
---

Hold each recorder halo atlas bitmap for one frame before closing it. The two smallest rings were seen blank intermittently on WebKit; the WebGL draw itself is correct, and the suspected cause is closing the bitmap straight after `drawImage`. This is a hardening change: the blank was not reproduced on demand, so the fix is unproven until checked on an iPhone.
