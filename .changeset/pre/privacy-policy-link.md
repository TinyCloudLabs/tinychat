---
"@tinychat/frontend": minor
---

The app links TinyCloud's privacy policy, `https://tinycloud.xyz/privacy` (TC-2876, App Store 5.1.1(i), Play User Data policy). The link appears in Settings → Account (signed in, and the signed-out phone Settings) and in How it works → Your data. It opens in the in-app browser on iOS and Android, in the system browser on desktop (a fixed-URL Tauri command), and in a new tab on the web.

The iOS privacy manifest now also declares Name, Purchase History, Product Interaction and Performance Data, to match the App Store privacy answers. The HealthKit purpose strings are now added to Debug builds only, and `ios-build.yml` fails a Release archive that has them.
