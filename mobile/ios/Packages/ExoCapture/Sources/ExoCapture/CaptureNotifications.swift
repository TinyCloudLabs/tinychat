import Foundation
import UserNotifications

public enum CaptureNotifications {
    public static func handle(response: UNNotificationResponse, completion: @escaping () -> Void) {
        completion()
    }
}
