---
"@tinychat/frontend": patch
"exo-desktop": patch
---

Home in a desktop Chromium browser opens to the Feed again without waiting about a second and a half for the node. Production web builds no longer bind the local copy of transcripts at sign-in or session restore, because web-sdk 3.11.2 holds the restore until that bind and the node's `/info` answer (TC-2773 removes the wait in web-sdk 3.12). A copy already on the device is kept, not deleted; signing out still erases it. The switch for the local copy is hidden while binding is paused. Details: TC-2883
