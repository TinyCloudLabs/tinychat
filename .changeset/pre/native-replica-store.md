---
"@tinychat/frontend": patch
"exo-desktop": patch
---

The iOS and Android apps get a native local store for your TinyCloud data: an encrypted SQLite copy kept outside the web view, with one file and one device-only key per account. Nothing uses it yet (it is switched off until the TinyCloud SDK can read from it), and signing out deletes that account's copy and its key. Details: TC-2862
