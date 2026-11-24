import Capacitor
import UIKit

/// The native half of "Report a bug" after a screenshot (TC-3716). iOS tells the app a screenshot was taken but does
/// not hand over the image (that needs Photos access), so this renders the app's own window at that moment, encodes a
/// small JPEG and holds it in memory for the web app (frontend/src/lib/reportBug/nativeScreenshot.ts) to take.
/// Nothing is written to disk. All state lives on the main thread.
public final class ScreenshotReportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenshotReportPlugin"
    public let jsName = "ScreenshotReport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeSnapshot", returnType: CAPPluginReturnPromise),
    ]

    private struct Snapshot {
        let id: String
        let jpeg: Data
        let width: Int
        let height: Int
    }

    private static let coalesceSeconds: TimeInterval = 1.5
    private static let holdSeconds: TimeInterval = 60
    private static let maxEdge: CGFloat = 1280
    private static let maxBytes = 400 * 1024
    private static let qualities: [CGFloat] = [0.6, 0.5, 0.4, 0.3]

    private var observer: NSObjectProtocol?
    private var lastSignal: TimeInterval?
    private var held: Snapshot?
    private var expiry: DispatchWorkItem?
    /// Bumped by stop(), so an encode still running then is neither held nor announced.
    private var generation = 0

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": true])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.observer == nil {
                self.observer = NotificationCenter.default.addObserver(
                    forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main
                ) { [weak self] _ in self?.screenshotTaken() }
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
            self.observer = nil
            self.generation += 1
            self.lastSignal = nil
            self.drop()
            call.resolve()
        }
    }

    /// Resolves `{ jpegBase64, width, height, bytes }` and forgets the image; rejects "no_snapshot" when the held
    /// image has another id, expired, failed to render, or was already taken.
    @objc func takeSnapshot(_ call: CAPPluginCall) {
        let id = call.getString("id")
        DispatchQueue.main.async {
            guard let snapshot = self.held, snapshot.id == id else {
                call.reject("no_snapshot", "no_snapshot")
                return
            }
            self.drop()
            call.resolve([
                "jpegBase64": snapshot.jpeg.base64EncodedString(),
                "width": snapshot.width,
                "height": snapshot.height,
                "bytes": snapshot.jpeg.count,
            ])
        }
    }

    private func screenshotTaken() {
        let now = ProcessInfo.processInfo.systemUptime
        if let last = lastSignal, now - last < Self.coalesceSeconds { return }
        lastSignal = now
        drop()
        let id = UUID().uuidString
        let at = Int((Date().timeIntervalSince1970 * 1000).rounded())
        let generation = self.generation
        let image = render()
        DispatchQueue.global(qos: .userInitiated).async {
            let jpeg = image.flatMap(Self.encode)
            DispatchQueue.main.async {
                guard generation == self.generation else { return }
                if let jpeg, let cgImage = image?.cgImage {
                    self.hold(Snapshot(id: id, jpeg: jpeg, width: cgImage.width, height: cgImage.height))
                }
                self.notifyListeners("screenshot", data: ["id": id, "at": at])
            }
        }
    }

    /// The app's window as it is on screen now, scaled so the long edge is at most `maxEdge` pixels.
    private func render() -> UIImage? {
        guard let window = bridge?.viewController?.view.window else { return nil }
        let bounds = window.bounds
        let longEdge = max(bounds.width, bounds.height)
        guard longEdge > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = min(max(window.traitCollection.displayScale, 1), Self.maxEdge / longEdge)
        format.opaque = true
        var drawn = false
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            drawn = window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        return drawn ? image : nil
    }

    private static func encode(_ image: UIImage) -> Data? {
        for quality in qualities {
            guard let jpeg = image.jpegData(compressionQuality: quality) else { return nil }
            if jpeg.count <= maxBytes { return jpeg }
        }
        return nil
    }

    private func hold(_ snapshot: Snapshot) {
        drop()
        held = snapshot
        let item = DispatchWorkItem { [weak self] in self?.drop() }
        expiry = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdSeconds, execute: item)
    }

    private func drop() {
        expiry?.cancel()
        expiry = nil
        held = nil
    }
}
