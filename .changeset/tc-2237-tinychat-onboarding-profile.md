---
"@tinychat/frontend": patch
---

TinyChat retrieval pack 0.1.1-onboarding.25: the skill uses the TinyCloud onboarding sign-in (`TC_PROFILE`, else `default`) instead of its own `tinychat-agent` profile, asks once with one OpenKey link when the profile can't read TinyChat yet, and takes the code the owner pastes in chat (`setup.mjs login --code`, stdin, or `tinychat_authorize` with `code`). Breaking for the pack: `--code-file`, `authorize --delivery`, `prepare --new-profile`, the HTML approval file, the OpenCode chat capture and `tinychat_signin_status` are removed, and the pack needs Node.js 22.20 and, for setup, TinyCloud CLI 1.5.0-beta.20 or later. The public setup page and the Settings prompt point to https://agents.tinycloud.xyz/chat.
