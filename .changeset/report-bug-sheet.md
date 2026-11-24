---
"@tinychat/frontend": minor
---

Report a bug (TC-3716), off unless `VITE_REPORT_BUG=true`: a Settings row and, after a screenshot, an offer to open a sheet with the app's own snapshot attached and a note field. The report is redacted on the device, signed with the session key and sent to the feedback service (`VITE_FEEDBACK_ORIGIN`, default https://feedback.tinycloud.xyz). Phones notice screenshots through a new ScreenshotReport plugin (iPhone, Android 14+); the browser and Mac app use keyboard signs.
