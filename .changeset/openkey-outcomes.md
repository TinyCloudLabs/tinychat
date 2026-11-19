---
"@tinychat/frontend": patch
---

When a One App asks for more access and OpenKey doesn't add it, One now says why. Before, a closed window, a refusal or a different account showed nothing. It uses lines One already shows: "Couldn't ask for permission. Nothing changed. Try again." when another try can help, the different-account line, and otherwise "{App} can't do this without that access."

Sending to Main after the session ran out now says "Your session expired. Sign in again to talk to Main." instead of "Main's reply didn't come through."

The Conversation Canvas permission error no longer adds OpenKey's raw error text after its sentence.

Details: TC-3445
