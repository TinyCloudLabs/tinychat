---
---

CI only: macOS jobs give `vite build` a 4 GB heap (it needs about 2 GB, the default limit on the 7 GB macos-26 runner), and the iOS simulator job builds the frontend before it boots the simulator. Nothing ships.
