import AVFoundation
import CaptureCore
import Foundation
import UIKit

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
        return (port.uid, Self.displayName(port), Self.kind(port))
    }

    private func configureForEnumeration() throws {
        let options: AVAudioSession.CategoryOptions = [.mixWithOthers, .allowBluetoothHFP, .defaultToSpeaker, .bluetoothHighQualityRecording]
        try session.setCategory(.playAndRecord, mode: .default, options: options)
    }

    private static func object(_ port: AVAudioSessionPortDescription) -> [String: String] {
        ["id": port.uid, "name": displayName(port), "kind": kind(port)]
    }

    private static func displayName(_ port: AVAudioSessionPortDescription) -> String {
        displayName(portType: port.portType, portName: port.portName, idiom: UIDevice.current.userInterfaceIdiom)
    }

    /// The built-in mic is named for the device; every other port keeps its own name (a headset or
    /// Bluetooth device names itself). iOS can hand back the raw port identifier ("MicrophoneBuiltIn")
    /// or an empty name, which is spelled out instead.
    static func displayName(portType: AVAudioSession.Port, portName: String,
                            idiom: UIUserInterfaceIdiom) -> String {
        if portType == .builtInMic {
            switch idiom {
            case .phone: return "iPhone Microphone"
            case .pad: return "iPad Microphone"
            default: return "Built-in Microphone"
            }
        }
        let name = portName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty, name != portType.rawValue { return name }
        switch portType {
        case .headsetMic: return "Headset Microphone"
        case .bluetoothHFP, .bluetoothLE, .bluetoothA2DP: return "Bluetooth Microphone"
        case .usbAudio: return "USB Microphone"
        case .carAudio: return "Car Audio"
        default: return spelledOut(portType.rawValue)
        }
    }

    private static func spelledOut(_ identifier: String) -> String {
        var words = ""
        for character in identifier {
            if character.isUppercase, !words.isEmpty { words.append(" ") }
            words.append(character)
        }
        return words.isEmpty ? "Microphone" : words
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
