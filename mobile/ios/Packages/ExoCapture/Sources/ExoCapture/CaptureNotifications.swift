import Foundation
import UserNotifications

public enum CaptureNotifications {
    private static let center = UNUserNotificationCenter.current()
    private static let queue = DispatchQueue(label: "xyz.tinycloud.exo.capture.notifications")
    private static func identifier(_ id: String) -> String { "capture.resume.\(id)" }

    public static func requestOnFirstRecording() {
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    public static func schedule(id: String, epoch: Int, reason: String) {
        queue.async {
            let content = UNMutableNotificationContent()
            content.title = "Recording paused"
            content.body = reason == "interruption"
                ? "Recording paused by a call or Siri. Tap to resume."
                : "Recording needs your attention. Tap to resume."
            content.sound = .default
            content.userInfo = ["id": id, "epoch": epoch]
            center.add(UNNotificationRequest(identifier: identifier(id), content: content,
                                             trigger: UNTimeIntervalNotificationTrigger(timeInterval: 45, repeats: false))) { error in
                if let error { NSLog("Exo capture notification scheduling failed: %@", String(describing: error)) }
            }
        }
    }

    public static func mediaServicesRestarted(id: String) {
        let content = UNMutableNotificationContent()
        content.title = "Recording restarted"
        content.body = "Recording restarted after an audio system reset"
        content.sound = .default
        content.userInfo = ["id": id, "reason": "media_services_reset"]
        center.add(UNNotificationRequest(identifier: "capture.reset.\(id).\(UUID().uuidString)",
                                         content: content, trigger: nil)) { error in
            if let error { NSLog("Exo capture reset notification failed: %@", String(describing: error)) }
        }
    }

    public static func recovered(id: String, pauseTimedOut: Bool = false) {
        let content = UNMutableNotificationContent()
        content.title = "Recording saved"
        content.body = pauseTimedOut ? "Exo saved your recording after an hour paused." :
            "Exo recovered your recording. Tap to open it."
        content.sound = .default
        content.userInfo = ["id": id, "recovered": true]
        center.add(UNNotificationRequest(identifier: "capture.recovered.\(id)",
                                         content: content, trigger: nil)) { error in
            if let error { NSLog("Exo recovered notification failed: %@", String(describing: error)) }
        }
    }

    public static func remove(id: String) {
        queue.async {
            let key = identifier(id)
            center.removePendingNotificationRequests(withIdentifiers: [key])
            center.removeDeliveredNotifications(withIdentifiers: [key])
        }
    }

    public static func handle(response: UNNotificationResponse, completion: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if info["recovered"] as? Bool == true {
            completion()
            return
        }
        if let id = info["id"] as? String, let epoch = info["epoch"] as? Int {
            DispatchQueue.main.async {
                CaptureEngine.shared.resumeFromNotification(id: id, epoch: epoch)
                completion()
            }
            return
        }
        completion()
    }

    @discardableResult public static func handleDelivery(_ notification: UNNotification) -> Bool {
        guard notification.request.identifier.hasPrefix("capture.resume.") else { return false }
        let info = notification.request.content.userInfo
        guard let id = info["id"] as? String, let epoch = info["epoch"] as? Int else { return true }
        DispatchQueue.main.async { CaptureEngine.shared.resumeFromNotification(id: id, epoch: epoch) }
        return true
    }
}
