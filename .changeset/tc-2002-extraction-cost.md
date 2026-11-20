---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Background memory extraction asks each model for its lowest reasoning setting, which keeps hidden reasoning tokens down on short turns; the turn's total includes the extraction once it settles.

Details: TC-2002
