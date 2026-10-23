---
"@tinychat/frontend": patch
---

Request decryption only when reading a saved key. Sign-in now requests only the encryption network create grant; the decrypt grant is requested as a separate step-up, limited to about one hour, before a saved key is read.
