---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

The web build includes connector secret permissions and the decrypt permission at sign-in for devices that have used Connectors. First use requests access through OpenKey in place. Remove the unused custom AssemblyAI key permission from the manifest.
