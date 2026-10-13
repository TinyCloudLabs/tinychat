import Capacitor
import Foundation
import os

/// Debug-only bridge for already-redacted JSON diagnostics from the web app.
public final class ExoDevLogPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ExoDevLogPlugin"
    public let jsName = "ExoDevLog"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise)]

    private static let queue = DispatchQueue(label: "xyz.tinycloud.exo.dev.log")
    private static let logger = Logger(subsystem: "xyz.tinycloud.exo.dev", category: "app")
    private static let limit = 5 * 1024 * 1024

    @objc public func append(_ call: CAPPluginCall) {
        #if DEBUG
        guard Bundle.main.bundleIdentifier == "xyz.tinycloud.exo.dev",
              let line = call.getString("line"), line.utf8.count < 8192,
              let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["at"] is String, object["kind"] is String,
              object["source_id"] == nil || object["source_id"] is String || object["source_id"] is NSNull
        else { call.resolve(); return }
        Self.queue.async {
            let directory = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Logs", isDirectory: true)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("exo-dev.log")
            let rotated = directory.appendingPathComponent("exo-dev.log.1")
            if let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size >= Self.limit {
                try? FileManager.default.removeItem(at: rotated)
                try? FileManager.default.moveItem(at: file, to: rotated)
            }
            if !FileManager.default.fileExists(atPath: file.path) {
                FileManager.default.createFile(atPath: file.path, contents: nil)
            }
            if let handle = try? FileHandle(forWritingTo: file) {
                defer { try? handle.close() }
                try? handle.seekToEnd()
                try? handle.write(contentsOf: Data((line + "\n").utf8))
            }
            Self.logger.info("\(line, privacy: .public)")
        }
        #endif
        call.resolve()
    }
}
