---
"exo-desktop": minor
"@tinychat/frontend": minor
---

The Mac app now updates itself (TC-4275): it checks for a new stable release at launch and every 4 hours, downloads it in the background and offers "Restart to update". It never restarts on its own and never offers the restart while a recording is in progress. Existing installs need one manual update to this version, from this release's DMG or with `desktop/scripts/exo-update.sh`; after that, updates are automatic.
