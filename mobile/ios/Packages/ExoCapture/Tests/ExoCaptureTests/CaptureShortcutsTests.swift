import CaptureCore
import XCTest
@testable import ExoCapture

/// Routing for the native recording shortcuts (quick action, App Shortcuts, the Control Center control): every one
/// goes through `startFromShortcut`, records its source, and leaves the recorder to present even before a WebView.
@MainActor final class CaptureShortcutsTests: XCTestCase {
    private var root: URL!
    private var engine: CaptureEngine!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("exo-shortcuts-\(UUID().uuidString)")
        engine = try CaptureEngine(testRoot: root)
        engine.debugForeground = true
    }

    override func tearDownWithError() throws {
        _ = try? engine.discard()
        engine = nil
        try? FileManager.default.removeItem(at: root)
    }

    func testSourcesAreWebCaptureSources() {
        // frontend/src/lib/voiceNotes/nativeVoiceNotes.ts CaptureSource; an unknown value would not be held.
        let web: Set<String> = ["in_app", "quick_action", "app_shortcut", "intent", "control", "tile", "widget", "notification"]
        for source in ShortcutSource.allCases {
            XCTAssertTrue(web.contains(source.rawValue), source.rawValue)
            XCTAssertNotEqual(source.rawValue, "in_app")
        }
    }

    func testEachSourceStartsARecordingWithThatSource() throws {
        for source in ShortcutSource.allCases {
            guard case .started(let id) = try engine.startFromShortcut(source) else {
                return XCTFail("\(source) did not start")
            }
            XCTAssertEqual(engine.status()["id"] as? String, id)
            XCTAssertEqual(engine.status()["source"] as? String, source.rawValue)
            XCTAssertEqual(engine.status()["state"] as? String, "recording")
            XCTAssertEqual(try engine.discard(), id)
        }
    }

    /// Cold launch as the app has it: ExoStt observes the engine from launch, the Live Activity hook is installed,
    /// and the shortcut starts before any WebView. The WebView that attaches later must find the live recording
    /// and its non-in_app source in `status()` (that is what makes the web recorder present it), and a listener
    /// attached at start time gets `presentRecorder`.
    func testColdStartLeavesTheRecordingForTheWebViewToPresent() throws {
        var launchObserverPresented: [String] = []
        let launchObserver = engine.observe { name, data, _ in
            if name == "presentRecorder", let value = data["id"] as? String { launchObserverPresented.append(value) }
        }
        defer { engine.removeObserver(launchObserver) }
        var hookStates: [String] = []
        engine.micStateChanged = { hookStates.append($0["state"] as? String ?? "?") }

        guard case .started(let id) = try engine.startFromShortcut(.intent) else { return XCTFail("not started") }

        XCTAssertEqual(launchObserverPresented, [id])
        XCTAssertEqual(hookStates, ["recording"])
        let status = engine.status()
        XCTAssertEqual(status["id"] as? String, id)
        XCTAssertEqual(status["state"] as? String, "recording")
        XCTAssertEqual(status["source"] as? String, "intent")
    }

    func testSecondShortcutPresentsTheLiveRecordingInsteadOfStartingAnother() throws {
        guard case .started(let id) = try engine.startFromShortcut(.quickAction) else { return XCTFail("not started") }
        var presented: [String] = []
        var attached = false  // the first start's retained events replay synchronously inside `observe`
        let token = engine.observe { name, data, _ in
            if attached, name == "presentRecorder", let value = data["id"] as? String { presented.append(value) }
        }
        attached = true
        defer { engine.removeObserver(token) }

        XCTAssertEqual(try engine.startFromShortcut(.control), .presentedExisting(id: id))
        XCTAssertEqual(presented, [id])
        XCTAssertEqual(engine.status()["source"] as? String, "quick_action")
    }

    func testMicStateHookSeesTheRecordingEnd() throws {
        var hookStates: [(state: String, id: String?)] = []
        engine.micStateChanged = { hookStates.append(($0["state"] as? String ?? "?", $0["id"] as? String)) }
        guard case .started(let id) = try engine.startFromShortcut(.control) else { return XCTFail("not started") }
        _ = try engine.discard()
        XCTAssertEqual(hookStates.map(\.state), ["recording", "idle"])
        XCTAssertEqual(hookStates.first?.id, id)
        XCTAssertNil(hookStates.last?.id)
    }
}
