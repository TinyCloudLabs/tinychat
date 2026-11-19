---
"@tinychat/backend": patch
---

Trim oversized web search results instead of failing the reply (TC-3464). A `web_search` result over 64K characters is cut to 64K with the `[...truncated...]` marker and the model answers from it; reading stops at a 256K hard bound, past which the reply still ends with `result_size_limit` (ours, free). Meeting reads keep failing on overflow, since their structured evidence cannot be cut.
