---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Send a notetaker accepts every Google Meet link shape: `/meet/<code>`, `/_meet/<code>`, `g.co/meet/<code>`, `tel.meet/<code>`, links wrapped in `accounts.google.com?continue=` or `meet.app.goo.gl?link=`, and a bare code with or without dashes. All become `https://meet.google.com/<code>` (lowercase, no trailing slash). A wrapper whose target is not a Meet link is refused. `meet.google.com/lookup/<nick>` is sent as pasted.
