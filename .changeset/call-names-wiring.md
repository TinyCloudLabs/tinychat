---
"exo-desktop": patch
---

The Mac app gets the native half of "names in the call". While a recording of both sides runs, and only after the user turns the setting on, the app reads the names of the people in the call from the meeting window (Google Meet in Chrome, Edge, Brave, Arc, Vivaldi or Chromium, and Zoom) through macOS Accessibility. It keeps them on this Mac until the note is saved. The setting is off, and no screen has its switch yet: the switch comes with the frontend change. Where the meeting app does not show which person is the user, the app takes the one person whose name is the Mac account's full name, or a name a meeting app marked as the user in an earlier call. The app never acts on the meeting window, never reads captions, and writes no name to a log.
