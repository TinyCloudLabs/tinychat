# iOS builds and device installs

TinyCloud Home (the iOS app; formerly Exo) requires iOS 26 or newer (Apple's on-device speech) and Capacitor CLI requires Node.js 22 or newer.
Capacitor generates `CapApp-SPM/Package.swift`
with Swift tools 6.2 from `mobile/capacitor.config.ts`. Run sync after building
the web app, and commit any intentional generated manifest change. A repeat sync
on a clean checkout should leave `git status` clean.

The App target takes its bundle identifier from the project-level
`EXO_BUNDLE_ID` build setting. It defaults to `xyz.tinycloud.home` for archives;
pass `EXO_BUNDLE_ID=xyz.tinycloud.home.dev` to build the device test app. The
debug-only HealthKit entitlements remain on Debug, so install Release on the
physical phone.

## Install on Vonnegut

Connect and trust the iPhone, then run from the repository root:

```sh
UDID=00008140-0006645414D2801C TEAM=R4QVKA785H \
  BUNDLE=xyz.tinycloud.home.dev mobile/scripts/ios-device-install.sh
xcrun devicectl device process launch --device 00008140-0006645414D2801C xyz.tinycloud.home.dev
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
  EXO_BUNDLE_ID=xyz.tinycloud.home.dev | rg PRODUCT_BUNDLE_IDENTIFIER
```

The first command must report `xyz.tinycloud.home`; the second must report
`xyz.tinycloud.home.dev`. The simulator smoke command and unsigned archive
checks are in `mobile/scripts/ios-simulator-smoke.sh` and
`.github/workflows/ios-build.yml`, respectively. Leave `EXO_DEV_SERVER_URL`
unset for an archive so the built app includes the frontend assets.
