import AVFoundation
import CaptureCore
import Foundation

/// Keeps the user's choice even when a headset is temporarily disconnected.
final class InputRouter {
    private let key = "exo.capture.preferredInputUid"
    private let session = AVAudioSession.sharedInstance()

    var selectedID: String? { UserDefaults.standard.string(forKey: key) }

    func list() throws -> [String: Any] {
        try configureForEnumeration()
        return ["inputs": (session.availableInputs ?? []).map(Self.object),
                "selectedId": selectedID as Any? ?? NSNull(),
                "activeId": session.currentRoute.inputs.first?.uid as Any? ?? NSNull()]
    }

    func select(_ id: String?) throws {
        try configureForEnumeration()
        if let id, !(session.availableInputs ?? []).contains(where: { $0.uid == id }) {
            throw CaptureError.invalidArgument
        }
        if let id { UserDefaults.standard.set(id, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    func apply() throws {
        guard let id = selectedID else { try session.setPreferredInput(nil); return }
        // A detached input stays selected for the next activation, but automatic routing is
        // used until it comes back.
        let available = (session.availableInputs ?? []).first(where: { $0.uid == id })
        try session.setPreferredInput(available)
    }

    func active() -> (id: String, name: String, kind: String)? {
        guard let port = session.currentRoute.inputs.first else { return nil }
        return (port.uid, port.portName, Self.kind(port))
    }

    private func configureForEnumeration() throws {
        var options: AVAudioSession.CategoryOptions = [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker]
        if #available(iOS 26.0, *) { options.insert(.bluetoothHighQualityRecording) }
        try session.setCategory(.playAndRecord, mode: .default, options: options)
    }

    private static func object(_ port: AVAudioSessionPortDescription) -> [String: String] {
        ["id": port.uid, "name": port.portName, "kind": kind(port)]
    }

    private static func kind(_ port: AVAudioSessionPortDescription) -> String {
        switch port.portType {
        case .builtInMic: "built_in"
        case .headsetMic: "wired"
        case .bluetoothHFP: "bluetooth"
        case .usbAudio: "usb"
        case .carAudio: "car"
        default: "other"
        }
    }
}
