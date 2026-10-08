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

    public static func schedule(id: String, epoch: Int) {
        queue.async {
            let content = UNMutableNotificationContent()
            content.title = "Recording paused"
            content.body = "Recording paused by a call or Siri. Tap to resume."
            content.sound = .default
            content.userInfo = ["id": id, "epoch": epoch]
            center.add(UNNotificationRequest(identifier: identifier(id), content: content,
                                             trigger: UNTimeIntervalNotificationTrigger(timeInterval: 45, repeats: false))) { error in
                if let error { NSLog("Exo capture notification scheduling failed: %@", String(describing: error)) }
            }
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
        if let id = info["id"] as? String, let epoch = info["epoch"] as? Int {
            DispatchQueue.main.async {
                CaptureEngine.shared.resumeFromNotification(id: id, epoch: epoch)
                completion()
            }
            return
        }
        completion()
    }

    public static func handleDelivery(_ notification: UNNotification) {
        let info = notification.request.content.userInfo
        guard let id = info["id"] as? String, let epoch = info["epoch"] as? Int else { return }
        DispatchQueue.main.async { CaptureEngine.shared.resumeFromNotification(id: id, epoch: epoch) }
    }
}
