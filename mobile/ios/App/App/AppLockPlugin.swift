import Capacitor
import Darwin
import LocalAuthentication
import UIKit

/// The native half of the app lock (TC-2738): device-owner authentication (Face ID / Touch ID, falling back to the
/// device passcode), how long the app spent in the background, and a cover over the window while it is backgrounded so
/// the app-switcher snapshot shows no data. The web app (frontend/src/lib/appLock.ts) owns every lock decision.
public final class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reveal", returnType: CAPPluginReturnPromise),
    ]

    private var coverEnabled = false
    private var cover: UIView?
    /// CLOCK_MONOTONIC keeps counting while the device sleeps, and the user can't move it like the wall clock.
    private var backgroundedAt: UInt64?
    private var pendingAuthentication: (() -> Void)?
    private var authenticating = false

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didEnterBackground),
                           name: UIScene.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(willEnterForeground),
                           name: UIScene.willEnterForegroundNotification, object: nil)
        center.addObserver(self, selector: #selector(didActivate),
                           name: UIScene.didActivateNotification, object: nil)
    }

    @objc func status(_ call: CAPPluginCall) {
        #if DEBUG
        // The simulator smoke (mobile/scripts/ios-simulator-smoke.sh) launches with the lock off.
        if ProcessInfo.processInfo.environment["EXO_APP_LOCK"] == "off" {
            call.resolve(["biometry": "none", "biometryEnrolled": false, "deviceSecure": false])
            return
        }
        #endif
        let context = LAContext()
        // biometryType is only populated after canEvaluatePolicy, enrolled or not.
        let enrolled = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        let biometry: String
        switch context.biometryType {
        case .faceID: biometry = "faceID"
        case .touchID: biometry = "touchID"
        case .opticID: biometry = "opticID"
        default: biometry = "none"
        }
        call.resolve([
            "biometry": biometry,
            "biometryEnrolled": enrolled,
            "deviceSecure": LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil),
        ])
    }

    /// Resolves `{ result }`: "success", "cancelled" (the user, the system or another app dismissed it),
    /// "failed", or "unavailable" (no passcode, so nothing can be asked).
    @objc func authenticate(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Unlock TinyCloud Home"
        DispatchQueue.main.async {
            guard !self.authenticating else { call.resolve(["result": "cancelled"]); return }
            let context = LAContext()
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
                call.resolve(["result": "unavailable"])
                return
            }
            self.authenticating = true
            let evaluate = {
                context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
                    DispatchQueue.main.async {
                        self.authenticating = false
                        call.resolve(["result": success ? "success" : Self.result(for: error)])
                    }
                }
            }
            // Face ID asked for while the scene is still coming to the foreground fails as not interactive.
            if UIApplication.shared.applicationState == .active { evaluate() } else { self.pendingAuthentication = evaluate }
        }
    }

    @objc func setCover(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            self.coverEnabled = enabled
            if !enabled { self.removeCover() }
            call.resolve()
        }
    }

    /// The web app has rendered its decision (the lock screen, or the unlocked app): drop the background cover.
    @objc func reveal(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.removeCover()
            call.resolve()
        }
    }

    private static func result(for error: Error?) -> String {
        switch (error as? LAError)?.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback, .notInteractive: return "cancelled"
        case .passcodeNotSet: return "unavailable"
        default: return "failed"
        }
    }

    private static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

    @objc private func didEnterBackground() {
        backgroundedAt = Self.now()
        guard coverEnabled, cover == nil, let host = bridge?.viewController?.view else { return }
        let view = UIView(frame: host.bounds)
        view.backgroundColor = .systemBackground
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.accessibilityElementsHidden = true
        host.addSubview(view)
        cover = view
    }

    @objc private func willEnterForeground() {
        guard let since = backgroundedAt else { return }
        backgroundedAt = nil
        let backgroundMs = Double(Self.now() - since) / 1_000_000
        notifyListeners("foreground", data: ["backgroundMs": backgroundMs])
    }

    @objc private func didActivate() {
        guard let evaluate = pendingAuthentication else { return }
        pendingAuthentication = nil
        evaluate()
    }

    private func removeCover() {
        cover?.removeFromSuperview()
        cover = nil
    }
}
