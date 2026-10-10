import AVFoundation
import UIKit
import XCTest
@testable import ExoCapture

final class InputRouterTests: XCTestCase {
    private func name(_ type: AVAudioSession.Port, _ portName: String,
                      _ idiom: UIUserInterfaceIdiom = .phone) -> String {
        InputRouter.displayName(portType: type, portName: portName, idiom: idiom)
    }

    func testBuiltInMicIsNamedForTheDeviceNotThePortIdentifier() {
        XCTAssertEqual(name(.builtInMic, "MicrophoneBuiltIn"), "iPhone Microphone")
        XCTAssertEqual(name(.builtInMic, "iPhone Microphone"), "iPhone Microphone")
        XCTAssertEqual(name(.builtInMic, "MicrophoneBuiltIn", .pad), "iPad Microphone")
        XCTAssertEqual(name(.builtInMic, "MicrophoneBuiltIn", .vision), "Built-in Microphone")
    }

    func testExternalPortsKeepTheirOwnName() {
        XCTAssertEqual(name(.headsetMic, "Lightning Headset"), "Lightning Headset")
        XCTAssertEqual(name(.bluetoothHFP, "Sam's AirPods Pro"), "Sam's AirPods Pro")
        XCTAssertEqual(name(.usbAudio, "Blue Yeti"), "Blue Yeti")
        XCTAssertEqual(name(.carAudio, "Mazda 3"), "Mazda 3")
    }

    func testEmptyOrRawIdentifierNamesFallBackToAReadableName() {
        XCTAssertEqual(name(.headsetMic, ""), "Headset Microphone")
        XCTAssertEqual(name(.bluetoothHFP, "  "), "Bluetooth Microphone")
        XCTAssertEqual(name(.usbAudio, "USBAudio"), "USB Microphone")
        XCTAssertEqual(name(.carAudio, ""), "Car Audio")
        XCTAssertEqual(name(AVAudioSession.Port(rawValue: "MicrophoneWired"), "MicrophoneWired"), "Headset Microphone")
        XCTAssertEqual(name(AVAudioSession.Port(rawValue: "CustomMicrophonePort"), "CustomMicrophonePort"), "Custom Microphone Port")
        XCTAssertEqual(name(AVAudioSession.Port(rawValue: ""), ""), "Microphone")
    }
}
