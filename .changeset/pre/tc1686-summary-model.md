---
"@tinychat/frontend": patch
---

Combined-meeting summaries use z-ai/glm-5.2 with output caps of 2500 (whole meeting) and 1500 (per chunk), which leave room for the model's reasoning tokens. A reply with no content is reported as a failed summary and nothing is saved (TC-1686).
