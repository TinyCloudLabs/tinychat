---
"@tinychat/frontend": patch
---

iOS and Android: a returning user's Feed no longer waits for the TinyCloud node to re-activate a delegation it already holds (TC-2865). Once a launch has seen the node accept the current delegation, later launches still send `/delegate`, but in the background. On the iOS simulator, the time to the first Feed card dropped from about 3.0 s to about 0.6 s. If a background activation fails, the next launch waits for activation again and shows its error. Sign-in and renewal still wait for activation.
