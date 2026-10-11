---
"exo-desktop": patch
"@tinychat/frontend": patch
---

Refresh the Library when the new recorder commits an on-device or private-cloud transcript (including recovery), a notetaker import, or an uploaded transcript. Revalidate only the saved note while preserving its audio and prior reads if refresh fails; ignore saves from a previous account.
