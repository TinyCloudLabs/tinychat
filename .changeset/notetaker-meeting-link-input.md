---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Send a notetaker accepts meeting links as people paste them. A link without `https://`, Google's `google.com/meet/<code>` form, a bare Meet code, a Gmail/Calendar or Outlook redirect, or a whole "Join with Google Meet" line now becomes the canonical meeting link before it goes to ptx. These used to fail with "That doesn't look like a meeting link" or "That meeting platform isn't supported yet". Any other link still goes upstream exactly as pasted, so capability links keep their query and fragment. The backend applies the same reading, so links from older clients work too.
