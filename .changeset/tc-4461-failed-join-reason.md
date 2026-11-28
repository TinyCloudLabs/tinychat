---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

A calendar auto-join recording that ends failed keeps the transcription service's error code on its record as one of a closed list of values; any other value is recorded as other and the service's message text is never kept. The decision log line for a failed recording carries that code, and every non-invitation decision line carries a keyed meeting pseudonym that ties a meeting's lines together. The Settings notetaker section shows the specific reason in plain words, such as the notetaker not being admitted from the waiting room in time or being removed from the meeting.

Details: TC-4461
