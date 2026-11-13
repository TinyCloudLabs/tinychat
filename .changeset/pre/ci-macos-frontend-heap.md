---
---

CI only: macOS jobs give `vite build` a 4 GB heap (it needs about 2 GB, the default limit on the 7 GB macos-26 runner). The iOS simulator job turns off the runner's Spotlight indexing and builds the frontend before it boots the simulator. Nothing ships.
