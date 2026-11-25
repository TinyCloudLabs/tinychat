---
"exo-desktop": patch
---

The Mac app gets the native half of "Record this call". When a call app (Zoom, Teams, Slack, FaceTime, Signal, Discord, Webex, WhatsApp, or a browser) has used the microphone for a few seconds, a small tile at the right edge of the screen offers to record the call. It never takes the keyboard from the call. Start begins a recording the same way the menu-bar item does; the main window comes forward only when the recording needs an answer first. Not now closes the tile for that call. The tile does not show while a recording runs. The app checks the microphone every 2 seconds, and only while the setting is on. It reads no audio and needs no permission. The list of processes is read only when the microphone is in use. The app keeps only which listed app is in the call, and it writes no app's name to a log. The setting is on by default. Its switch comes with the frontend change. When the main window closes, the app quits, so the tile never keeps it running.
