import AVFoundation
import CaptureCore
import ExoCapture
import ExoStt
import UIKit
import UserNotifications

enum AppLifecycleHooks {
    static func setAppActive(_ active: Bool) { CaptureEngine.shared.setAppActive(active) }
    static func didFinishLaunching(_ app: UIApplication,
                                   options: [UIApplication.LaunchOptionsKey: Any]?) {
        ExoCaptureBootstrap.start()
        CaptureLiveActivity.install()
        ExoSttBootstrap.start()
        UNUserNotificationCenter.current().delegate = app.delegate as? UNUserNotificationCenterDelegate
        #if DEBUG
        if ["cold", "cold_warm"].contains(ProcessInfo.processInfo.environment["EXO_QUICK_ACTION_SMOKE"] ?? "") {
            // Exercise the same quick-action handler before a scene or WebView exists.
            _ = performShortcut(UIApplicationShortcutItem(type: "xyz.tinycloud.exo.record", localizedTitle: "Record"))
        }
        #endif
        if let raw = ProcessInfo.processInfo.environment["EXO_CAPTURE_PROBE_SECONDS"],
           let seconds = Int(raw), (1...300).contains(seconds) {
            // Release-enabled solely for the signed D-IOS device validation recipe.
            runDeviceProbe(seconds: seconds)
        }
        #if DEBUG
        // ExoBridgeViewController runs the capture smoke once after WebView mount.
        #endif
    }

    static func handleEventsForBackgroundURLSession(_ identifier: String,
                                                    completionHandler: @escaping () -> Void) -> Bool {
        ModelDownloads.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
    }

    static func didReceive(_ response: UNNotificationResponse, completion: @escaping () -> Void) {
        CaptureNotifications.handle(response: response, completion: completion)
    }

    private static func runDeviceProbe(seconds: Int) {
        AVAudioApplication.requestRecordPermission { allowed in
            DispatchQueue.main.async {
                guard allowed else { NSLog("EXO_DEVICE_PROBE permission_denied"); return }
                do {
                    let started = try CaptureEngine.shared.start(source: "in_app")
                    NSLog("EXO_DEVICE_PROBE started id=%@", started["id"] as? String ?? "unknown")
                    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(seconds)) {
                        CaptureEngine.shared.stop { result in
                            switch result {
                            case .success(let note):
                                NSLog("EXO_DEVICE_PROBE stopped id=%@ durationMs=%@ sizeBytes=%@",
                                      note["id"] as? String ?? "unknown",
                                      String(describing: note["durationMs"] ?? "unknown"),
                                      String(describing: note["sizeBytes"] ?? "unknown"))
                            case .failure(let error): NSLog("EXO_DEVICE_PROBE stop_failed %@", String(describing: error))
                            }
                        }
                    }
                } catch { NSLog("EXO_DEVICE_PROBE start_failed %@", String(describing: error)) }
            }
        }
    }

    @discardableResult static func performShortcut(_ item: UIApplicationShortcutItem) -> Bool {
        guard item.type == "xyz.tinycloud.exo.record" else { return false }
        let record = {
            do {
                let result = try CaptureEngine.shared.start(source: "quick_action")
                NSLog("EXO_QUICK_ACTION started id=%@ at=%@", result["id"] as? String ?? "unknown",
                      String(describing: result["startedAt"] ?? "unknown"))
            }
            catch CaptureError.alreadyRecording {
                CaptureEngine.shared.presentRecorder()
                NSLog("EXO_QUICK_ACTION presented existing recording")
            }
            catch { NSLog("Exo quick action could not start: %@", String(describing: error)) }
        }
        if AVAudioApplication.shared.recordPermission == .granted { record() }
        else { AVAudioApplication.requestRecordPermission { allowed in
            guard allowed else { return }
            DispatchQueue.main.async(execute: record)
        } }
        return true
    }
}
