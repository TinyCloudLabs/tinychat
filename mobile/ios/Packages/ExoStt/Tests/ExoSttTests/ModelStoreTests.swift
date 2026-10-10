import XCTest
@testable import ExoStt

final class ModelStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("modelstore-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    /// A silero_vad.onnx of the pinned size but the wrong content: present on disk, fails its sha256.
    private func installCorruptVad() throws {
        let file = try XCTUnwrap(ModelManifest.filesFor(ModelManifest.sileroVad)?.first)
        let dir = root.appendingPathComponent(ModelManifest.sileroVad, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(count: Int(file.bytes)).write(to: dir.appendingPathComponent(file.name))
    }

    func testAnEmptyStoreIsFinalImmediately() {
        let store = ModelStore(root: root)
        XCTAssertFalse(store.isChecking)
        XCTAssertEqual(store.status(ModelManifest.sileroVad).state, .absent)
    }

    func testInstalledModelsReportCheckingWithoutBlockingInitUntilTheBackgroundHashFinishes() throws {
        try installCorruptVad()
        let gate = DispatchSemaphore(value: 0)
        let entered = expectation(description: "background verification started")
        var store: ModelStore!
        let initMs = elapsedMs { store = ModelStore(root: root, beforeBackgroundVerify: { entered.fulfill(); gate.wait() }) }
        XCTAssertLessThan(initMs, 500)
        wait(for: [entered], timeout: 5)

        var state = ModelState.absent
        XCTAssertLessThan(elapsedMs { state = store.status(ModelManifest.sileroVad).state }, 200)
        XCTAssertEqual(state, .checking)
        XCTAssertTrue(store.isChecking)
        XCTAssertFalse(store.isReady(ModelManifest.sileroVad))
        XCTAssertEqual(store.status(ModelManifest.parakeetSmall).state, .absent) // nothing installed: no check needed

        let finished = expectation(description: "observer notified")
        store.onInitialCheckFinished { finished.fulfill() }
        gate.signal()
        wait(for: [finished], timeout: 10)
        XCTAssertFalse(store.isChecking)
        XCTAssertEqual(store.status(ModelManifest.sileroVad).state, .absent) // corrupt file never becomes ready
    }

    func testAnObserverAddedAfterTheCheckIsNotifiedToo() throws {
        try installCorruptVad()
        let store = ModelStore(root: root)
        let first = expectation(description: "check finished")
        store.onInitialCheckFinished { first.fulfill() }
        wait(for: [first], timeout: 10)
        let late = expectation(description: "late observer")
        store.onInitialCheckFinished { late.fulfill() }
        wait(for: [late], timeout: 5)
    }

    private func elapsedMs(_ body: () -> Void) -> Double {
        let startedAt = DispatchTime.now()
        body()
        return Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
    }
}
