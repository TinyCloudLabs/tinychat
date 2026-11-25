---
"@tinychat/backend": patch
---

The chat route accepts one more model, `moonshotai/kimi-k3.1-pro`, for background calls only: a request has to set both an output limit and a reasoning setting, and the model then runs at low reasoning effort. It is not offered for conversations, does not appear in the model list, and the agent chat route refuses it.
