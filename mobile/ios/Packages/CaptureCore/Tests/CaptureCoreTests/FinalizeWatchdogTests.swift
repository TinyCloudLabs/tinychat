import XCTest
@testable import CaptureCore

final class FinalizeWatchdogTests: XCTestCase {
    func testSlowButProgressingMuxIsNeverStalled() {
        var watchdog = MuxWatchdog(startedAt: 0, stallSeconds: 45, ceilingSeconds: 600)
        // Ten minutes of audio on a throttled phone: far longer than the old 60 s budget,
        // but a sample lands every 20 s.
        for step in 1...25 {
            XCTAssertEqual(watchdog.observe(ticks: step, bytes: 0, now: Double(step) * 20), .running, "step \(step)")
        }
    }

    func testOutputGrowthAloneCountsAsProgress() {
        var watchdog = MuxWatchdog(startedAt: 0, stallSeconds: 45, ceilingSeconds: 600)
        for step in 1...19 {
            XCTAssertEqual(watchdog.observe(ticks: 7, bytes: Int64(step) * 1_000, now: Double(step) * 30), .running)
        }
        XCTAssertEqual(watchdog.observe(ticks: 7, bytes: 20_000, now: 600), .ceilingReached,
                       "progress never bypasses the ceiling")
    }

    func testNoProgressForTheStallWindowFailsFromTheLastChange() {
        var watchdog = MuxWatchdog(startedAt: 0, stallSeconds: 45, ceilingSeconds: 600)
        XCTAssertEqual(watchdog.observe(ticks: 3, bytes: 10, now: 100), .running)
        XCTAssertEqual(watchdog.observe(ticks: 3, bytes: 10, now: 144.9), .running)
        XCTAssertEqual(watchdog.observe(ticks: 3, bytes: 10, now: 145), .stalled)
    }

    func testAMuxThatNeverReportsProgressStallsFromItsStart() {
        var watchdog = MuxWatchdog(startedAt: 500, stallSeconds: 45, ceilingSeconds: 600)
        XCTAssertEqual(watchdog.observe(ticks: 0, bytes: 0, now: 544), .running)
        XCTAssertEqual(watchdog.observe(ticks: 0, bytes: 0, now: 545), .stalled)
    }

    func testCeilingEndsAMuxThatKeepsMakingTinyProgress() {
        var watchdog = MuxWatchdog(startedAt: 0, stallSeconds: 45, ceilingSeconds: 600)
        XCTAssertEqual(watchdog.observe(ticks: 1, bytes: 0, now: 599), .running)
        XCTAssertEqual(watchdog.observe(ticks: 2, bytes: 0, now: 600), .ceilingReached)
    }

    func testCeilingScalesWithDurationAndIsBounded() {
        XCTAssertEqual(MuxWatchdog.ceilingSeconds(forAudioMs: 1_000), 600)
        XCTAssertEqual(MuxWatchdog.ceilingSeconds(forAudioMs: 618_000), 1_854)
        XCTAssertEqual(MuxWatchdog.ceilingSeconds(forAudioMs: 10_800_000), 14_400)
        XCTAssertEqual(MuxWatchdog.ceilingSeconds(forAudioMs: 100_000_000), 14_400)
    }

    func testRetryBackoffIsTwoThenThirtyThenNextLaunch() {
        XCTAssertEqual(FinalizeRetrySchedule.delay(afterFailures: 0), 2)
        XCTAssertEqual(FinalizeRetrySchedule.delay(afterFailures: 1), 30)
        XCTAssertNil(FinalizeRetrySchedule.delay(afterFailures: 2))
        XCTAssertNil(FinalizeRetrySchedule.delay(afterFailures: -1))
    }
}
