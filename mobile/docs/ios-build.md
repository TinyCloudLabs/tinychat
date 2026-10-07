# iOS builds and device installs

Exo requires iOS 18 or newer and Capacitor CLI requires Node.js 22 or newer.
Capacitor generates `CapApp-SPM/Package.swift`
with Swift tools 6.0 from `mobile/capacitor.config.ts`. Run sync after building
the web app, and commit any intentional generated manifest change. A repeat sync
on a clean checkout should leave `git status` clean.

The App target takes its bundle identifier from the project-level
`EXO_BUNDLE_ID` build setting. It defaults to `xyz.tinycloud.exo` for archives;
pass `EXO_BUNDLE_ID=xyz.tinycloud.exo.dev` to build the device test app. The
debug-only HealthKit entitlements remain on Debug, so install Release on the
physical phone.

## Install on Vonnegut

Connect and trust the iPhone, then run from the repository root:

```sh
UDID=00008140-0006645414D2801C TEAM=UDTLDX736A \
  BUNDLE=xyz.tinycloud.exo.dev mobile/scripts/ios-device-install.sh
xcrun devicectl device process launch --device 00008140-0006645414D2801C xyz.tinycloud.exo.dev
```

The script builds packages and the production frontend, syncs Capacitor,
signs a Release build, checks for another in-progress install, and installs
over the existing app. It never uninstalls, so the phone's saved notes remain.
`EXO_IOS_DERIVED_DATA` optionally changes its build output directory.

## Verify a build

```sh
cd mobile/ios/App
xcodebuild -showBuildSettings -project App.xcodeproj -scheme App -configuration Release | rg PRODUCT_BUNDLE_IDENTIFIER
xcodebuild -showBuildSettings -project App.xcodeproj -scheme App -configuration Release \
  EXO_BUNDLE_ID=xyz.tinycloud.exo.dev | rg PRODUCT_BUNDLE_IDENTIFIER
```

The first command must report `xyz.tinycloud.exo`; the second must report
`xyz.tinycloud.exo.dev`. The simulator smoke command and unsigned archive
checks are in `mobile/scripts/ios-simulator-smoke.sh` and
`.github/workflows/ios-build.yml`, respectively. Leave `EXO_DEV_SERVER_URL`
unset for an archive so the built app includes the frontend assets.
