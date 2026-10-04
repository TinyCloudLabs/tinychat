#if EXO_HEALTH
import Capacitor
import Foundation
import HealthKit
import UIKit

/// Health spike (TC-525): read health data from HealthKit. Compiled only with the `EXO_HEALTH` Swift condition,
/// which only the Debug configuration sets (with the HealthKit entitlements, App/App.entitlements), so a Release
/// build has no HealthKit code, entitlement or plugin. Same JS contract as the Android plugin
/// (frontend/src/lib/health/nativeHealth.ts):
///
///   availability()                        → { platform, status, reason, permissionsDeclared, backgroundRead,
///                                             historyRead }
///   authorizationStatus({ types? })       → { readStateKnowable: false, types: { steps: ... }, background,
///                                             sampleWrite }
///   requestAuthorization({ types?, sampleWrite? }) → the same, after the Health sheet is answered
///   readDailySummaries({ days?, types? }) → { platform, source, timeZone, readAt, notGranted, days: [...] }
///   insertSampleData()                    → { inserted } (development: sample steps, sleep, heart rate)
///   openSettings()                        → {} (opens the Health app; iOS has no deep link to an app's access)
///   enableBackgroundDelivery({ types? })  → { enabled, errors, frequency }; then "healthDataChanged" events
///
/// HealthKit never tells an app whether it may READ a type: a denied read looks exactly like no data. What the app
/// can learn is whether it has already asked (getRequestStatusForAuthorization: shouldRequest vs unnecessary),
/// so a read type's state is "not_determined" (never asked) or "unknown" (asked; the answer is private). Write
/// (share) authorization is visible, which is what `sampleWrite` reports.
@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authorizationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readDailySummaries", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "insertSampleData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enableBackgroundDelivery", returnType: CAPPluginReturnPromise)
    ]

    static let allTypes = ["steps", "sleep", "heartRate"]
    private static let maxDays = 30
    /// HKCategoryValueSleepAnalysis raw values that mean asleep: asleepUnspecified (iOS 15's `asleep`), asleepCore,
    /// asleepDeep, asleepREM. inBed (0) and awake (2) are not sleep.
    private static let asleepValues: Set<Int> = [1, 3, 4, 5]
    /// A sleep interval counts for day D when it ends between 18:00 on D-1 and 18:00 on D (the night of the 3rd to
    /// the 4th is the 4th; an afternoon nap is its own day). Android uses the same rule.
    private static let sleepDayStartHour = 18
    private static let bpm = HKUnit.count().unitDivided(by: HKUnit.minute())

    private let store = HKHealthStore()
    private var observers: [HKObserverQuery] = []

    private static func sampleType(_ type: String) -> HKSampleType? {
        switch type {
        case "steps": return HKObjectType.quantityType(forIdentifier: .stepCount)
        case "heartRate": return HKObjectType.quantityType(forIdentifier: .heartRate)
        case "sleep": return HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        default: return nil
        }
    }

    /// `types` from the call, default all; rejects the call (and returns nil) on an unknown or empty list.
    private func types(_ call: CAPPluginCall) -> [String]? {
        guard let requested = call.getArray("types", String.self) else { return Self.allTypes }
        var types: [String] = []
        for type in requested {
            guard Self.allTypes.contains(type) else {
                call.reject("Unknown health data type: \(type)", "invalid_type")
                return nil
            }
            if !types.contains(type) { types.append(type) }
        }
        if types.isEmpty {
            call.reject("No health data type requested", "invalid_type")
            return nil
        }
        return types
    }

    // MARK: - Availability

    @objc func availability(_ call: CAPPluginCall) {
        let available = HKHealthStore.isHealthDataAvailable()
        var ret: [String: Any] = [
            "platform": "ios",
            "status": available ? "available" : "unavailable",
            "reason": NSNull(),
            "permissionsDeclared": Bundle.main.object(forInfoDictionaryKey: "NSHealthShareUsageDescription") != nil,
            // Background delivery is an entitlement, not a user permission; enableBackgroundDelivery reports it.
            "backgroundRead": "unknown",
            // HealthKit has no history limit; Health Connect reads 30 days before the first grant without one.
            "historyRead": "available"
        ]
        if !available { ret["reason"] = "device_unsupported" }
        call.resolve(ret)
    }

    // MARK: - Authorization

    @objc func authorizationStatus(_ call: CAPPluginCall) {
        guard let types = types(call) else { return }
        authorization(for: types) { result in
            switch result {
            case .success(let data): call.resolve(data)
            case .failure(let error): self.reject(call, error, fallback: "permission_check_failed")
            }
        }
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard let types = types(call) else { return }
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Health data is not available on this device", "unavailable")
            return
        }
        var read = Set<HKObjectType>()
        var share = Set<HKSampleType>()
        let sampleWrite = call.getBool("sampleWrite", false)
        for type in types {
            guard let sampleType = Self.sampleType(type) else { continue }
            read.insert(sampleType)
            if sampleWrite { share.insert(sampleType) }
        }
        // Shows the Health sheet only for types never asked for; the completion's `success` says the request was
        // handled, never whether reading was allowed.
        store.requestAuthorization(toShare: share, read: read) { _, error in
            if let error = error {
                self.reject(call, error, fallback: "request_failed")
                return
            }
            self.authorization(for: types) { result in
                switch result {
                case .success(let data): call.resolve(data)
                case .failure(let error): self.reject(call, error, fallback: "permission_check_failed")
                }
            }
        }
    }

    private func authorization(for types: [String], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else {
            var states: [String: String] = [:]
            for type in types { states[type] = "unavailable" }
            completion(.success(["readStateKnowable": false, "types": states, "background": "unavailable", "sampleWrite": "not_granted"]))
            return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var states: [String: String] = [:]
        var failure: Error?
        for type in types {
            guard let sampleType = Self.sampleType(type) else { continue }
            group.enter()
            store.getRequestStatusForAuthorization(toShare: [], read: [sampleType]) { status, error in
                lock.lock()
                if let error = error {
                    failure = failure ?? error
                } else {
                    states[type] = status == .shouldRequest ? "not_determined" : "unknown"
                }
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .global(qos: .userInitiated)) {
            if let failure = failure {
                completion(.failure(failure))
                return
            }
            var sampleWrite = true
            for type in types {
                guard let sampleType = Self.sampleType(type) else { continue }
                if self.store.authorizationStatus(for: sampleType) != .sharingAuthorized { sampleWrite = false }
            }
            completion(.success([
                "readStateKnowable": false,
                "types": states,
                "background": "not_applicable",
                "sampleWrite": sampleWrite ? "granted" : "not_granted"
            ]))
        }
    }

    // MARK: - Reading

    private struct Day {
        var steps: Double?
        var sleep: [(Date, Date)] = []
        var heartRateMin: Double?
        var heartRateAvg: Double?
        var heartRateMax: Double?
        var sources = Set<String>()
    }

    /// One summary per local calendar day, oldest first, for the last `days` days including today. Steps and heart
    /// rate come from HKStatisticsCollectionQuery with daily intervals (HealthKit merges overlapping iPhone and Watch
    /// samples). Sleep is the union of asleep samples per night (the 18:00 rule above), so overlapping sources do
    /// not double count. A type never asked for is skipped and listed in `notGranted`; a denied type cannot be told
    /// apart and simply reads as null.
    @objc func readDailySummaries(_ call: CAPPluginCall) {
        guard let types = types(call) else { return }
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Health data is not available on this device", "unavailable")
            return
        }
        let days = max(1, min(Self.maxDays, call.getInt("days", 7)))
        authorization(for: types) { result in
            switch result {
            case .failure(let error):
                self.reject(call, error, fallback: "permission_check_failed")
            case .success(let auth):
                let states = auth["types"] as? [String: String] ?? [:]
                // A query on a type never requested fails with errorAuthorizationNotDetermined.
                let asked = types.filter { states[$0] == "unknown" }
                self.readDays(types: types, asked: asked, days: days) { result in
                    switch result {
                    case .success(let data): call.resolve(data)
                    case .failure(let error): self.reject(call, error, fallback: "read_failed")
                    }
                }
            }
        }
    }

    private func readDays(types: [String], asked: [String], days: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        guard let first = calendar.date(byAdding: .day, value: -(days - 1), to: today),
              let end = calendar.date(byAdding: .day, value: 1, to: today) else {
            completion(.failure(NSError(domain: "xyz.tinycloud.exo.health", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bad date range"])))
            return
        }
        let dayStarts = (0..<days).compactMap { calendar.date(byAdding: .day, value: $0, to: first) }
        var byDay: [Date: Day] = [:]
        for start in dayStarts { byDay[start] = Day() }
        let lock = NSLock()
        let group = DispatchGroup()
        var failure: Error?

        func record(_ error: Error?) {
            if let error = error, failure == nil { failure = error }
        }

        if asked.contains("steps"), let type = HKObjectType.quantityType(forIdentifier: .stepCount) {
            group.enter()
            statistics(type, options: [.cumulativeSum, .separateBySource], from: first, to: end) { collection, error in
                lock.lock()
                record(error)
                collection?.enumerateStatistics(from: first, to: end) { stats, _ in
                    let day = calendar.startOfDay(for: stats.startDate)
                    guard byDay[day] != nil else { return }
                    if let sum = stats.sumQuantity() { byDay[day]?.steps = sum.doubleValue(for: .count()) }
                    for source in stats.sources ?? [] { byDay[day]?.sources.insert(source.bundleIdentifier) }
                }
                lock.unlock()
                group.leave()
            }
        }

        if asked.contains("heartRate"), let type = HKObjectType.quantityType(forIdentifier: .heartRate) {
            group.enter()
            statistics(type, options: [.discreteMin, .discreteAverage, .discreteMax, .separateBySource], from: first, to: end) { collection, error in
                lock.lock()
                record(error)
                collection?.enumerateStatistics(from: first, to: end) { stats, _ in
                    let day = calendar.startOfDay(for: stats.startDate)
                    guard byDay[day] != nil, let avg = stats.averageQuantity() else { return }
                    byDay[day]?.heartRateAvg = avg.doubleValue(for: Self.bpm)
                    byDay[day]?.heartRateMin = stats.minimumQuantity()?.doubleValue(for: Self.bpm)
                    byDay[day]?.heartRateMax = stats.maximumQuantity()?.doubleValue(for: Self.bpm)
                    for source in stats.sources ?? [] { byDay[day]?.sources.insert(source.bundleIdentifier) }
                }
                lock.unlock()
                group.leave()
            }
        }

        if asked.contains("sleep"), let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis),
           let windowStart = calendar.date(byAdding: .hour, value: Self.sleepDayStartHour - 24, to: first),
           let windowEnd = calendar.date(byAdding: .hour, value: Self.sleepDayStartHour, to: today) {
            group.enter()
            let predicate = HKQuery.predicateForSamples(withStart: windowStart, end: windowEnd, options: [])
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                lock.lock()
                record(error)
                for case let sample as HKCategorySample in samples ?? [] where Self.asleepValues.contains(sample.value) {
                    let day = Self.sleepDay(for: sample.endDate, calendar: calendar)
                    guard byDay[day] != nil else { continue }
                    byDay[day]?.sleep.append((sample.startDate, sample.endDate))
                    byDay[day]?.sources.insert(sample.sourceRevision.source.bundleIdentifier)
                }
                lock.unlock()
                group.leave()
            }
            store.execute(query)
        }

        group.notify(queue: .global(qos: .userInitiated)) {
            if let failure = failure {
                completion(.failure(failure))
                return
            }
            var out: [[String: Any]] = []
            for start in dayStarts {
                let day = byDay[start] ?? Day()
                var json: [String: Any] = ["date": Self.dateString(start, calendar: calendar)]
                if types.contains("steps") {
                    if let steps = day.steps {
                        json["steps"] = Int(steps.rounded())
                    } else {
                        json["steps"] = NSNull()
                    }
                }
                if types.contains("sleep") {
                    let (minutes, blocks) = Self.asleep(day.sleep)
                    if blocks > 0 {
                        json["sleepMinutes"] = minutes
                    } else {
                        json["sleepMinutes"] = NSNull()
                    }
                    json["sleepBlocks"] = blocks
                }
                if types.contains("heartRate") {
                    if let avg = day.heartRateAvg {
                        json["heartRate"] = [
                            "min": Int((day.heartRateMin ?? avg).rounded()),
                            "avg": Int(avg.rounded()),
                            "max": Int((day.heartRateMax ?? avg).rounded())
                        ]
                    } else {
                        json["heartRate"] = NSNull()
                    }
                }
                json["sources"] = day.sources.sorted()
                out.append(json)
            }
            completion(.success([
                "platform": "ios",
                "source": "healthkit",
                "timeZone": TimeZone.current.identifier,
                "readAt": Int(Date().timeIntervalSince1970 * 1000),
                "readStateKnowable": false,
                "notGranted": types.filter { !asked.contains($0) },
                "days": out
            ]))
        }
    }

    private func statistics(_ type: HKQuantityType, options: HKStatisticsOptions, from start: Date, to end: Date,
                            completion: @escaping (HKStatisticsCollection?, Error?) -> Void) {
        let query = HKStatisticsCollectionQuery(
            quantityType: type,
            quantitySamplePredicate: HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate),
            options: options,
            anchorDate: start,
            intervalComponents: DateComponents(day: 1)
        )
        query.initialResultsHandler = { _, collection, error in completion(collection, error) }
        store.execute(query)
    }

    private static func sleepDay(for end: Date, calendar: Calendar) -> Date {
        calendar.startOfDay(for: end.addingTimeInterval(TimeInterval((24 - sleepDayStartHour) * 3600)))
    }

    /// Minutes covered by the union of the intervals, and how many separate blocks that union has.
    private static func asleep(_ intervals: [(Date, Date)]) -> (Int, Int) {
        let sorted = intervals.sorted { $0.0 < $1.0 }
        var total: TimeInterval = 0
        var blocks = 0
        var current: (Date, Date)?
        for interval in sorted {
            if let open = current, interval.0 <= open.1 {
                current = (open.0, max(open.1, interval.1))
            } else {
                if let open = current { total += open.1.timeIntervalSince(open.0) }
                current = interval
                blocks += 1
            }
        }
        if let open = current { total += open.1.timeIntervalSince(open.0) }
        return (Int(total / 60), blocks)
    }

    private static func dateString(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    // MARK: - Development helpers

    /// Saves a week of made-up steps, sleep and heart rate as Exo, for the simulator or a phone with no Watch.
    /// Needs write (share) access: requestAuthorization with sampleWrite. Each sample has a sync identifier, so a
    /// second run does not duplicate them. The user can delete them in Health → Browse → (type) → Data Sources.
    @objc func insertSampleData(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable(),
              let stepsType = HKObjectType.quantityType(forIdentifier: .stepCount),
              let heartRateType = HKObjectType.quantityType(forIdentifier: .heartRate),
              let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            call.reject("Health data is not available on this device", "unavailable")
            return
        }
        let calendar = Calendar.current
        let now = Date()
        let today = calendar.startOfDay(for: now)
        let canWriteSteps = store.authorizationStatus(for: stepsType) == .sharingAuthorized
        let canWriteHeartRate = store.authorizationStatus(for: heartRateType) == .sharingAuthorized
        let canWriteSleep = store.authorizationStatus(for: sleepType) == .sharingAuthorized
        var samples: [HKObject] = []
        for offset in 0..<7 {
            guard let day = calendar.date(byAdding: .day, value: -offset, to: today) else { continue }
            let seed = calendar.ordinality(of: .day, in: .year, for: day) ?? offset
            let key = Self.dateString(day, calendar: calendar)
            if canWriteSteps {
                for hour in [8, 12, 18] {
                    guard let start = calendar.date(byAdding: .hour, value: hour, to: day) else { continue }
                    let end = start.addingTimeInterval(45 * 60)
                    if end > now { continue }
                    let count = Double(900 + (seed * 37 + hour * 101) % 2600)
                    samples.append(HKQuantitySample(type: stepsType, quantity: HKQuantity(unit: .count(), doubleValue: count),
                                                    start: start, end: end, metadata: Self.sampleMetadata("exo-sample-steps-\(key)-\(hour)")))
                }
            }
            if canWriteHeartRate, let start = calendar.date(byAdding: .hour, value: 10, to: day) {
                for minute in 0..<6 {
                    let time = start.addingTimeInterval(TimeInterval(60 * minute))
                    if time > now { continue }
                    let value = Double(58 + (seed * 7 + minute * 5) % 35)
                    samples.append(HKQuantitySample(type: heartRateType, quantity: HKQuantity(unit: Self.bpm, doubleValue: value),
                                                    start: time, end: time, metadata: Self.sampleMetadata("exo-sample-hr-\(key)-\(minute)")))
                }
            }
            if canWriteSleep,
               let start = calendar.date(byAdding: .minute, value: -60 + seed % 50, to: day),
               let end = calendar.date(byAdding: .minute, value: 6 * 60 + 30 + seed % 40, to: day),
               end <= now {
                samples.append(HKCategorySample(type: sleepType, value: 1, start: start, end: end,
                                                metadata: Self.sampleMetadata("exo-sample-sleep-\(key)")))
            }
        }
        if samples.isEmpty {
            call.reject("No write access: request authorization with sampleWrite first", "not_authorized")
            return
        }
        store.save(samples) { _, error in
            if let error = error {
                self.reject(call, error, fallback: "write_failed")
            } else {
                call.resolve(["inserted": samples.count])
            }
        }
    }

    private static func sampleMetadata(_ syncIdentifier: String) -> [String: Any] {
        [HKMetadataKeySyncIdentifier: syncIdentifier, HKMetadataKeySyncVersion: 1, HKMetadataKeyWasUserEntered: true]
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: "x-apple-health://") else {
                call.reject("Could not open the Health app", "unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("Could not open the Health app", "unavailable") }
            }
        }
    }

    // MARK: - Background delivery

    /// Registers an HKObserverQuery per type and asks HealthKit to wake the app (at most hourly for steps) when
    /// new samples arrive; each wake emits "healthDataChanged". Needs the background-delivery entitlement. A
    /// real sync must re-register the observers in application(_:didFinishLaunchingWithOptions:) (HealthKit
    /// relaunches the app into the background for them), read with an HKAnchoredObjectQuery, write to TinyCloud
    /// natively (the WebView may not run), and call the completion handler promptly: HealthKit backs off after
    /// three missed handlers. See mobile/docs/health-spike.md.
    @objc func enableBackgroundDelivery(_ call: CAPPluginCall) {
        guard let types = types(call) else { return }
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Health data is not available on this device", "unavailable")
            return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var enabled: [String] = []
        var errors: [String: String] = [:]
        for type in types {
            guard let sampleType = Self.sampleType(type) else { continue }
            if !observers.contains(where: { $0.objectType?.identifier == sampleType.identifier }) {
                let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { [weak self] _, completionHandler, error in
                    var event: [String: Any] = ["type": type, "at": Int(Date().timeIntervalSince1970 * 1000)]
                    if let error = error { event["error"] = error.localizedDescription }
                    self?.notifyListeners("healthDataChanged", data: event, retainUntilConsumed: true)
                    completionHandler()
                }
                store.execute(query)
                observers.append(query)
            }
            group.enter()
            store.enableBackgroundDelivery(for: sampleType, frequency: .hourly) { success, error in
                lock.lock()
                if success {
                    enabled.append(type)
                } else {
                    errors[type] = error?.localizedDescription ?? "failed"
                }
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .global(qos: .userInitiated)) {
            call.resolve(["enabled": enabled, "errors": errors, "frequency": "hourly"])
        }
    }

    // MARK: - Errors

    private func reject(_ call: CAPPluginCall, _ error: Error, fallback: String) {
        let nsError = error as NSError
        var code = fallback
        if nsError.domain == HKErrorDomain, let hkCode = HKError.Code(rawValue: nsError.code) {
            switch hkCode {
            case .errorHealthDataUnavailable, .errorHealthDataRestricted: code = "unavailable"
            // Also what a build without the com.apple.developer.healthkit entitlement gets.
            case .errorAuthorizationDenied: code = "not_authorized"
            case .errorAuthorizationNotDetermined: code = "not_determined"
            case .errorUserCanceled: code = "canceled"
            default: break
            }
        }
        call.reject("\(nsError.localizedDescription) [\(nsError.domain) \(nsError.code)]", code, error)
    }
}
#endif
