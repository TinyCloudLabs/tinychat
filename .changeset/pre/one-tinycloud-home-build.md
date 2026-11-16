---
"@tinychat/frontend": minor
"exo-desktop": minor
---

One TinyCloud Home: home.tinycloud.xyz, tinycloud.chat, the desktop app and the mobile apps now run the same build. The `VITE_HOME_SITE` build flag, its separate production upload job and the Home-only sign-in grant (`manifest.home.json`) are gone.

- Every platform opens on Feed, named Home, with the tabs Home, Chat, Apps, Recording and Connectors in that order. Signed out on the web you see the Home front page with its demo feed, and the install prompt waits until you have signed in.
- Every web build signs in with `manifest.json`'s storage, without the connector secrets or the decrypt grant until this device has used Connectors. Opening Connectors the first time asks OpenKey for them in place, once. Recording no longer asks for its own permission, and Local copy, Agent access, Conversation Canvas and every Settings section are available on home.tinycloud.xyz too. If you signed in on home.tinycloud.xyz under the narrower Home grant, you sign in once more. The desktop and mobile apps sign in as before.
- tinycloud.chat moves you to home.tinycloud.xyz with the same path, query and `#` link. If this browser still holds recordings that are only saved on tinycloud.chat, you stay there with a notice and move automatically once they are saved.

Details: TC-2050
