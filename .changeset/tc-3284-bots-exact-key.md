---
"@tinychat/backend": patch
---

When TrustBot asks you to approve a secret for a call, the request now also names that secret's own encryption key. Secrets saved with their own key can then be read once you approve. Secrets saved earlier keep working through the approval that already covers your whole account's encryption.

Details: TC-3284
