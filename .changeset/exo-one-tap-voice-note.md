---
"@tinychat/frontend": minor
---

Exo mobile: record a voice note from the chat screen, and the Google connect dialog stops offering what the app can't do yet.

- **One-tap voice note.** Inside the native app, the header has a "Voice note" button. One tap starts recording and opens a bar under the header with the elapsed time, the level meter, the same microphone-state warnings as the Voice notes card (the system blocking the mic, no sound arriving) and Stop. The chat stays usable underneath. Stop saves the note to your TinyCloud space, after which the bar offers Open Library. If the save fails, the bar says so and the note stays on the phone. The bar uses the Voice notes card's own recorder, so saved notes appear in Connectors → Sources and Library as before. The button is not shown on Connectors, where the card has its own Record and takes over a recording that is still running. The web and desktop apps are unchanged.
- **Google connect in the app.** While a build keeps Google sign-in off inside the app, the Google Meet and Calendar autojoin dialogs show the "isn't available in the Exo app yet" explanation and a Close button instead of "Continue with Google". When a build turns it on, the consent text says you sign in "in your browser" instead of "in a popup window". The web and desktop dialogs are unchanged.
