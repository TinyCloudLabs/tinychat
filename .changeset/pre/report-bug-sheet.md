---
"@tinychat/frontend": minor
---

TinyCloud One can send bug reports: a Settings row, and an offer after a screenshot that opens a sheet with a note field and the app's own screenshot attached. The report is redacted on the device, signed with the session key and sent to the feedback service. iPhone and Android 14+ notice screenshots; the browser and the Mac app notice screenshot keys.

Ships off because the feedback service has no route for these reports (`/reports/app`); turn it on by setting `VITE_REPORT_BUG=true` once that route is live.

Details: TC-3716
