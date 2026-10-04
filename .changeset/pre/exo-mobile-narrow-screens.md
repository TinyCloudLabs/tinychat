---
"@tinychat/frontend": patch
---

Exo mobile: the app opens on chat instead of the marketing page, stays clear of the status bar, notch and gesture bar, and reads properly on phone-width screens.

- **Opens in the app.** Inside the native app, `/` goes straight to `/chat`, where a signed-out user gets the sign-in screen. The web and desktop apps still open on the landing page.
- **Safe areas.** The app shell now pads the left and right safe-area insets (landscape notch, side navigation bar) as well as the top one. The agent access prompt and its "Agent tools active." toast sit above the home indicator. Desktop browsers and the desktop app report zero insets, so their layout is unchanged.
- **Agent access prompt on phones.** Below the `sm` breakpoint the "Connect private agent access" prompt spans the screen with its button under the text. It used to be squeezed into half the width. From `sm` up it is the same centred row as before.
- **Library titles on phones.** Below `sm`, a meeting or voice-note title gets its own line, with the source chip and date under it, so "Voice note · Sep 29, 1:40 PM" is no longer cut to "Voice note · Sep 29, 1…". From `sm` up the row is unchanged.
