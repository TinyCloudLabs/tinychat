import Foundation
import Darwin
import OSLog

/// All metadata publications go through one synchronous queue. Muxing and probing run outside it,
/// holding an operation generation that delete/discard can invalidate at any time.
public final class RecordingLibrary {
    private let log = Logger(subsystem: "xyz.tinycloud.exo", category: "capture.finalizer")
    public struct SyncMetric {
        public let count: Int
        public let meanMs: Double
        public let maxMs: Double
    }

    public let root: URL
    private let queue = DispatchQueue(label: "xyz.tinycloud.exo.capture.library")
    private var generations: [String: UInt64] = [:]
    private var active: [String: Int] = [:]
    private var liveSessions: Set<String> = []
    private var countedRecoveryFailures: Set<String> = []
    // Launch recovery only owns sessions left by an earlier library instance.
    // A session started here can finish while the asynchronous launch scan runs.
    private var startedHere: Set<String> = []
    private var didRecover = false
    private let metricLock = NSLock()
    private var syncDurations: [String: (count: Int, totalMs: Double, maxMs: Double)] = [:]
    public var gate: ((String) -> Void)?
    public var failpoint: ((String) throws -> Void)?

    public init(root: URL) throws {
        self.root = root
        for name in ["", "sessions", "staging", "tombstones", "outbox", "quarantine"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(name, isDirectory: true),
                                                    withIntermediateDirectories: true)
        }
    }

    public func url(_ name: String) -> URL { root.appendingPathComponent(name) }
    public func audioURL(_ id: String) -> URL { url("\(id).m4a") }
    public func sidecarURL(_ id: String) -> URL { url("\(id).json") }
    public var accountStateURL: URL { url("account-state.json") }

    public func accountState() throws -> CaptureAccountState {
        try queue.sync { try accountStateUnlocked() }
    }

    private func accountStateUnlocked() throws -> CaptureAccountState {
        guard FileManager.default.fileExists(atPath: accountStateURL.path) else { return CaptureAccountState() }
        return try JSONDecoder().decode(CaptureAccountState.self, from: Data(contentsOf: accountStateURL))
    }

    public func migrateLegacyAccount(_ legacy: CaptureDefaults?) throws {
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: accountStateURL.path) else { return }
            // Preferences had no durable acknowledgement. Keep the prior generation and options,
            // but require the next ready handshake before assigning an owner.
            let old = legacy ?? CaptureDefaults()
            try writeAccountStateUnlocked(CaptureAccountState(status: legacy == nil ? "signed_out" : "transitioning",
                                                             accountDid: old.accountDid,
                                                             transitionGen: old.transitionGen,
                                                             options: CaptureOptions(transcriber: old.transcriber,
                                                                                     identifySpeakers: old.identifySpeakers)))
        }
    }

    public func setAccountState(_ state: CaptureAccountState) throws {
        guard ["signed_in", "transitioning", "signed_out"].contains(state.status),
              state.transitionGen >= 0,
              state.status != "signed_in" || state.accountDid?.isEmpty == false,
              state.status != "signed_out" || state.accountDid == nil else { throw CaptureError.invalidArgument }
        try queue.sync {
            let old = try accountStateUnlocked()
            guard state.transitionGen >= old.transitionGen else { throw CaptureError.staleTransition }
            try writeAccountStateUnlocked(state)
        }
    }

    private func writeAccountStateUnlocked(_ state: CaptureAccountState) throws {
        let tmp = url("account-state.json.tmp")
        try check("account.tmp")
        try writeDurable(JSONEncoder().encode(state), to: tmp)
        try check("account.rename")
        if FileManager.default.fileExists(atPath: accountStateURL.path) {
            _ = try FileManager.default.replaceItemAt(accountStateURL, withItemAt: tmp)
        } else { try FileManager.default.moveItem(at: tmp, to: accountStateURL) }
        try sync(root)
    }
    public func sessionURL(_ id: String) -> URL { url("sessions/\(id)") }
    public func journalURL(_ id: String) -> URL { sessionURL(id).appendingPathComponent("journal.jsonl") }
    public func segmentURL(_ id: String, index: Int) -> URL {
        sessionURL(id).appendingPathComponent(String(format: "seg-%05d.aac", index))
    }

    public static func validID(_ id: String) -> Bool { UUID(uuidString: id) != nil && id == id.lowercased() }
    private static func validOpID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy {
            $0 >= 32 && $0 != 47 && $0 != 92 && $0 != 127
        }
    }

    public func appendSegment(_ data: Data, to handle: FileHandle) throws {
        try check("seg.write")
        try handle.write(contentsOf: data)
    }

    private func check(_ name: String) throws { try failpoint?(name) }
    public func syncMetrics() -> [String: SyncMetric] {
        metricLock.lock(); defer { metricLock.unlock() }
        return syncDurations.mapValues { values in
            SyncMetric(count: values.count, meanMs: values.totalMs / Double(values.count),
                       maxMs: values.maxMs)
        }
    }

    private func recordSync(_ kind: String, since: TimeInterval) {
        let milliseconds = (ProcessInfo.processInfo.systemUptime - since) * 1000
        metricLock.lock()
        var metric = syncDurations[kind] ?? (count: 0, totalMs: 0, maxMs: 0)
        metric.count += 1; metric.totalMs += milliseconds; metric.maxMs = max(metric.maxMs, milliseconds)
        syncDurations[kind] = metric
        metricLock.unlock()
    }

    private func sync(_ path: URL, barrier: Bool = false) throws {
        let fd = open(path.path, O_RDONLY)
        guard fd >= 0 else { throw CaptureError.io("open \(path.lastPathComponent): \(errno)") }
        defer { close(fd) }
        let started = ProcessInfo.processInfo.systemUptime
        #if os(iOS)
        let command = barrier ? F_BARRIERFSYNC : F_FULLFSYNC
        if fcntl(fd, command) == 0 {
            recordSync(barrier ? "F_BARRIERFSYNC" : "F_FULLFSYNC", since: started)
            return
        }
        // APFS simulator and directory descriptors may reject Apple's stronger sync operation.
        guard errno == EINVAL || errno == ENOTSUP else {
            throw CaptureError.io("sync \(path.lastPathComponent): \(errno)")
        }
        #endif
        guard fsync(fd) == 0 else { throw CaptureError.io("fsync \(path.lastPathComponent): \(errno)") }
        recordSync("fsync_fallback", since: started)
    }

    private func writeDurable(_ data: Data, to path: URL) throws {
        try data.write(to: path, options: .atomic)
        try sync(path)
    }

    public func appendJournal(_ id: String, _ event: [String: Any], fullSync: Bool = false) throws {
        let line = try JournalCodec.line(event)
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                throw CaptureError.tombstoned
            }
            let path = journalURL(id)
            let handle = try FileHandle(forWritingTo: path)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try check("stop.journal")
            try sync(path, barrier: !fullSync)
        }
    }

    public func startSession(_ info: SessionInfo) throws {
        guard Self.validID(info.id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(info.id)").path) else {
                throw CaptureError.tombstoned
            }
            try check("start.mkdir")
            try FileManager.default.createDirectory(at: sessionURL(info.id), withIntermediateDirectories: false)
            startedHere.insert(info.id)
            try sync(url("sessions"))
            try check("start.journal")
            try writeDurable(JournalCodec.line(info.journalEvent()), to: journalURL(info.id))
            try sync(sessionURL(info.id))
            liveSessions.insert(info.id)
        }
    }

    public func openFirstSegment(_ id: String, at: Int64 = wallMilliseconds()) throws {
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                throw CaptureError.tombstoned
            }
            let segment = segmentURL(id, index: 0)
            guard FileManager.default.createFile(atPath: segment.path, contents: nil) else {
                throw CaptureError.io("create first segment")
            }
            try sync(sessionURL(id))
            try appendJournalUnlocked(id, ["e": "segment", "t": at, "a": 0,
                                                "index": 0, "file": segment.lastPathComponent])
        }
    }

    private func appendJournalUnlocked(_ id: String, _ event: [String: Any], fullSync: Bool = true) throws {
        let line = try JournalCodec.line(event)
        let handle = try FileHandle(forWritingTo: journalURL(id))
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: line)
        try sync(journalURL(id), barrier: !fullSync)
    }

    public func rollSegment(_ id: String, next: Int, audioMs: Int64,
                            at: Int64 = wallMilliseconds()) throws -> URL {
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                throw CaptureError.tombstoned
            }
            try sync(segmentURL(id, index: next - 1))
            try check("roll.create")
            let segment = segmentURL(id, index: next)
            if FileManager.default.fileExists(atPath: segment.path),
               (try segment.resourceValues(forKeys: [.fileSizeKey])).fileSize == 0 {
                try FileManager.default.removeItem(at: segment)
            }
            guard FileManager.default.createFile(atPath: segment.path, contents: nil) else {
                throw CaptureError.io("create segment")
            }
            try sync(sessionURL(id))
            try appendJournalUnlocked(id, ["e": "segment", "t": at, "a": audioMs,
                                           "index": next, "file": segment.lastPathComponent])
            return segment
        }
    }

    public func checkpoint(_ id: String, segment: Int, bytes: Int64, audioMs: Int64,
                           intent: String, availability: String, fullSync: Bool = false,
                           at: Int64 = wallMilliseconds()) throws {
        try queue.sync {
            try check("seg.sync")
            try sync(segmentURL(id, index: segment), barrier: !fullSync)
            try appendJournalUnlocked(id, ["e": "hb", "t": at, "a": audioMs,
                                           "seg": segment, "segBytes": bytes, "intent": intent,
                                           "availability": availability], fullSync: fullSync)
        }
    }

    public func fullSyncSegment(_ id: String, index: Int) throws {
        try queue.sync {
            try sync(segmentURL(id, index: index))
            try sync(journalURL(id))
        }
    }

    public func readJournal(_ id: String) throws -> [[String: Any]] {
        try queue.sync { try JournalCodec.read(Data(contentsOf: journalURL(id))) }
    }

    private func beginOperation(_ id: String) throws -> UInt64 {
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                throw CaptureError.tombstoned
            }
            active[id, default: 0] += 1
            return generations[id, default: 0]
        }
    }

    private func endOperation(_ id: String) {
        queue.sync {
            active[id, default: 1] -= 1
        }
    }

    public func commit(_ id: String, sidecar: [String: Any],
                       makeM4A: (URL) throws -> Void) throws -> [String: Any] {
        let generation = try beginOperation(id)
        let staged = url("staging/\(id).\(generation).\(UUID().uuidString.lowercased()).m4a")
        defer { endOperation(id) }
        defer { try? FileManager.default.removeItem(at: staged) }
        gate?("stage.begin")
        do {
            try makeM4A(staged)
            try check("stage.write")
            log.notice("commit stage=fsync outcome=start id=\(id, privacy: .public)")
            try sync(staged)
            log.notice("commit stage=fsync outcome=completed id=\(id, privacy: .public)")
            gate?("stage.afterMux")
            return try queue.sync {
                guard generations[id, default: 0] == generation,
                      !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                    throw CaptureError.tombstoned
                }
                guard !FileManager.default.fileExists(atPath: sidecarURL(id).path) else {
                    // A repeated recovery must never overwrite a newer sidecar revision.
                    return try readSidecarUnlocked(id)
                }
                if FileManager.default.fileExists(atPath: audioURL(id).path) {
                    // A crash after audio rename but before the sidecar commit leaves an
                    // unpublished audio file. Recovery may replace it from durable segments.
                    try FileManager.default.removeItem(at: audioURL(id))
                    try sync(root)
                }
                try check("publish.m4aRename")
                try FileManager.default.moveItem(at: staged, to: audioURL(id))
                try sync(root)
                var record = sidecar
                record["sizeBytes"] = (try audioURL(id).resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
                try publishSidecarUnlocked(id, record, failpointName: "publish.sidecarTmp")
                try check("publish.gc")
                try? FileManager.default.removeItem(at: sessionURL(id))
                try sync(url("sessions"))
                liveSessions.remove(id)
                return record
            }
        } catch { throw error }
    }

    private func readSidecarUnlocked(_ id: String) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: sidecarURL(id))) as? [String: Any] else {
            throw CaptureError.io("malformed sidecar")
        }
        return object
    }

    public func readSidecar(_ id: String) throws -> [String: Any] { try queue.sync { try readSidecarUnlocked(id) } }

    public func localAudioURL(_ id: String) throws -> URL {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        return try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
                  FileManager.default.fileExists(atPath: audioURL(id).path) else { throw CaptureError.notFound }
            return audioURL(id)
        }
    }

    public func openAudio(_ id: String) throws -> FileHandle {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        return try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
                  FileManager.default.fileExists(atPath: audioURL(id).path) else {
                throw CaptureError.notFound
            }
            return try FileHandle(forReadingFrom: audioURL(id))
        }
    }

    private func publishSidecarUnlocked(_ id: String, _ object: [String: Any], failpointName: String) throws {
        guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
            throw CaptureError.tombstoned
        }
        let tmp = url("\(id).json.tmp")
        try check(failpointName)
        try writeDurable(CanonicalJSON.file(object), to: tmp)
        try check("publish.sidecarRename")
        let destination = sidecarURL(id)
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: tmp)
        } else {
            try FileManager.default.moveItem(at: tmp, to: destination)
        }
        try sync(root)
    }

    public func listCommitted() throws -> [[String: Any]] {
        try queue.sync {
            try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" && !$0.lastPathComponent.hasSuffix(".transcript.json") }
                .compactMap { path in
                    let id = path.deletingPathExtension().lastPathComponent
                    guard Self.validID(id), FileManager.default.fileExists(atPath: audioURL(id).path),
                          !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
                          var item = try? readSidecarUnlocked(id) else { return nil }
                    if item["version"] == nil && item["ownerUnknown"] == nil { item["ownerUnknown"] = true }
                    return item
                }
        }
    }

    public func claim(_ id: String, did: String, evidence: String, rowId: String? = nil) throws -> String? {
        guard !did.isEmpty else { throw CaptureError.invalidArgument }
        guard ["signed_out_v2", "space_row", "user_choice"].contains(evidence) else {
            throw CaptureError.claimEvidenceInvalid
        }
        if evidence == "space_row", rowId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            throw CaptureError.rowIDRequired
        }
        return try queue.sync {
            try check("claim.write")
            var item = try readSidecarUnlocked(id)
            let legacy = item["version"] == nil || item["legacyImport"] as? Bool == true ||
                item["ownerUnknown"] as? Bool == true
            if legacy && evidence == "signed_out_v2" { throw CaptureError.claimEvidenceRequired }
            if !legacy && evidence != "signed_out_v2" { throw CaptureError.claimEvidenceInvalid }
            guard item["owner"] is NSNull || item["owner"] == nil || item["owner"] as? String == did else {
                throw CaptureError.ownerMismatch
            }
            if item["owner"] as? String == did {
                if evidence == "space_row", let rowId {
                    var ledger = item["ledger"] as? [String: Any] ?? [:]
                    let audio = ledger["audio"] as? [String: Any]
                    if audio?["state"] as? String != "saved" || audio?["rowId"] as? String != rowId {
                        ledger["audio"] = ["state": "saved", "rowId": rowId, "at": wallMilliseconds()]
                        item["ledger"] = ledger
                        item["rev"] = (item["rev"] as? Int ?? 0) + 1
                        try publishSidecarUnlocked(id, item, failpointName: "claim.write")
                    }
                }
                return did
            }
            item["owner"] = did
            item["ownerUnknown"] = false
            if evidence == "space_row", let rowId {
                var ledger = item["ledger"] as? [String: Any] ?? [:]
                ledger["audio"] = ["state": "saved", "rowId": rowId, "at": wallMilliseconds()]
                item["ledger"] = ledger
            }
            item["rev"] = (item["rev"] as? Int ?? 0) + 1
            try publishSidecarUnlocked(id, item, failpointName: "claim.write")
            return did
        }
    }

    public func updateLedger(_ id: String, did: String, rev: Int, patch: [String: Any]) throws -> Int {
        try queue.sync {
            try check("ledger.write")
            var item = try readSidecarUnlocked(id)
            guard item["owner"] as? String == did else { throw CaptureError.ownerMismatch }
            guard item["rev"] as? Int == rev else { throw CaptureError.revConflict }
            var ledger = item["ledger"] as? [String: Any] ?? [:]
            ledger.merge(patch) { _, newer in newer }
            item["ledger"] = ledger
            item["rev"] = rev + 1
            try publishSidecarUnlocked(id, item, failpointName: "ledger.write")
            return rev + 1
        }
    }

    public func beginRemoteOp(_ receipt: [String: Any]) throws {
        guard let id = receipt["id"] as? String, Self.validID(id),
              let did = receipt["did"] as? String, !did.isEmpty,
              let opId = receipt["opId"] as? String, Self.validOpID(opId),
              let provider = receipt["provider"] as? String, ["assemblyai", "ptx"].contains(provider),
              let kind = receipt["kind"] as? String,
              ["hosted_create", "hosted_submit", "own_upload", "own_create", "ptx_create"].contains(kind) else {
            throw CaptureError.invalidArgument
        }
        try queue.sync {
            try check("receipt.begin")
            let account = try accountStateUnlocked()
            if account.status == "signed_in", account.accountDid == did,
               !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
               FileManager.default.fileExists(atPath: sidecarURL(id).path),
               var item = try? readSidecarUnlocked(id), item["owner"] as? String == did {
                var ledger = item["ledger"] as? [String: Any] ?? [:]
                var remote = ledger["remote"] as? [[String: Any]] ?? []
                if !remote.contains(where: { $0["opId"] as? String == opId }) {
                    var open = receipt
                    open["stage"] = "\(kind)_unknown"
                    remote.append(open); ledger["remote"] = remote; item["ledger"] = ledger
                    item["rev"] = (item["rev"] as? Int ?? 0) + 1
                    try publishSidecarUnlocked(id, item, failpointName: "receipt.begin")
                }
            } else {
                try writeReceiptOutboxUnlocked(id: id, opId: opId, receipt: receipt, result: nil)
            }
        }
    }

    @discardableResult public func recordRemoteResult(id: String, did: String, opId: String,
                                                       result: [String: Any]) throws -> String {
        guard Self.validID(id), Self.validOpID(opId), !did.isEmpty,
              ["created", "failed", "unknown"].contains(result["outcome"] as? String ?? "") else {
            throw CaptureError.invalidArgument
        }
        return try queue.sync {
            try check("receipt.result")
            if !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
               FileManager.default.fileExists(atPath: sidecarURL(id).path),
               var item = try? readSidecarUnlocked(id), item["owner"] as? String == did {
                var ledger = item["ledger"] as? [String: Any] ?? [:]
                var remote = ledger["remote"] as? [[String: Any]] ?? []
                if let index = remote.firstIndex(where: { $0["opId"] as? String == opId }) {
                    remote[index].merge(result) { _, new in new }
                    ledger["remote"] = remote; item["ledger"] = ledger
                    item["rev"] = (item["rev"] as? Int ?? 0) + 1
                    try publishSidecarUnlocked(id, item, failpointName: "receipt.result")
                    return "ledger"
                }
            }
            let path = receiptOutboxURL(id: id, opId: opId)
            guard let data = try? Data(contentsOf: path),
                  let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw CaptureError.notFound
            }
            try writeReceiptOutboxUnlocked(id: id, opId: opId, receipt: receipt, result: result)
            return "outbox"
        }
    }

    private func receiptOutboxURL(id: String, opId: String) -> URL { url("outbox/\(id):\(opId).json") }

    private func writeReceiptOutboxUnlocked(id: String, opId: String, receipt: [String: Any],
                                            result: [String: Any]?) throws {
        try check("delete.outbox")
        let path = receiptOutboxURL(id: id, opId: opId)
        let existing = (try? JSONSerialization.jsonObject(with: Data(contentsOf: path))) as? [String: Any]
        let kind = receipt["opKind"] as? String ?? receipt["kind"] as? String ?? "unknown"
        let mode = receipt["mode"] ?? NSNull()
        let job = result?["jobId"] ?? receipt["jobId"]
        let upload = result?["uploadId"] ?? receipt["uploadId"]
        let uploadURL = result?["uploadUrl"] ?? receipt["uploadUrl"]
        let direct = result?["handle"] ?? receipt["handle"]
        let outboxKind: String
        let handle: Any?
        let state: String
        switch kind {
        case "hosted_create":
            outboxKind = "hosted_upload"; handle = upload ?? direct
            state = handle == nil ? "unknown" : "pending"
        case "hosted_submit" where job == nil && direct == nil:
            outboxKind = "hosted_submit"; handle = upload
            state = handle == nil ? "unknown" : "lookup"
        case "own_upload":
            outboxKind = "own_upload_lookup"; handle = uploadURL
            state = handle == nil ? "unknown" : "lookup"
        case "own_create" where job == nil && direct == nil:
            outboxKind = "own_upload_lookup"; handle = uploadURL
            state = handle == nil ? "unknown" : "lookup"
        default:
            outboxKind = kind == "ptx_create" ? "ptx_job" : "transcript"
            handle = job ?? direct
            state = handle == nil ? "unknown" : "pending"
        }
        var entry: [String: Any] = existing ?? ["entryId": "\(id):\(opId)", "did": receipt["did"] ?? "",
            "provider": receipt["provider"] ?? "", "mode": mode,
            "kind": outboxKind, "opKind": kind,
            "createdAt": receipt["startedAt"] ?? wallMilliseconds(), "attempts": 0]
        entry["kind"] = outboxKind
        entry["opKind"] = kind
        entry["handle"] = handle ?? NSNull()
        entry["handleExpiresAt"] = result?["handleExpiresAt"] ?? receipt["handleExpiresAt"] ?? NSNull()
        entry["state"] = state
        try writeDurable(CanonicalJSON.file(entry), to: path)
        try sync(url("outbox"))
    }

    /// Native-only progress/state updates for the on-device STT queue (no owner/rev check: the
    /// queue is the sole writer of this field, and JS only ever reads it).
    public func updateStt(_ id: String, patch: [String: Any]) throws {
        try queue.sync {
            try check("stt.write")
            var item = try readSidecarUnlocked(id)
            var stt = item["stt"] as? [String: Any] ?? [:]
            stt.merge(patch) { _, newer in newer }
            item["stt"] = stt
            item["rev"] = (item["rev"] as? Int ?? 0) + 1
            try publishSidecarUnlocked(id, item, failpointName: "stt.write")
        }
    }

    public func putTranscript(_ id: String, object: [String: Any]) throws {
        let generation = try beginOperation(id)
        let staged = url("staging/\(id).\(generation).\(UUID().uuidString.lowercased()).transcript.json")
        defer { endOperation(id) }
        defer { try? FileManager.default.removeItem(at: staged) }
        do {
            try writeDurable(CanonicalJSON.file(object), to: staged)
            gate?("stt.beforePublish")
            try queue.sync {
                guard generations[id, default: 0] == generation,
                      !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                    throw CaptureError.tombstoned
                }
                let final = url("\(id).transcript.json")
                if FileManager.default.fileExists(atPath: final.path) { try FileManager.default.removeItem(at: final) }
                try FileManager.default.moveItem(at: staged, to: final)
                try sync(root)
            }
        } catch { throw error }
    }

    public func transcript(_ id: String) throws -> [String: Any]? {
        try queue.sync {
            let path = url("\(id).transcript.json")
            guard FileManager.default.fileExists(atPath: path.path) else { return nil }
            return try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any]
        }
    }

    public func delete(_ id: String) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            generations[id, default: 0] += 1
            try check("delete.tombstone")
            let tombstone = url("tombstones/\(id)")
            if !FileManager.default.fileExists(atPath: tombstone.path) {
                guard FileManager.default.createFile(atPath: tombstone.path, contents: Data()) else {
                    throw CaptureError.io("create tombstone")
                }
                try sync(url("tombstones"))
            }
            if let item = try? readSidecarUnlocked(id) {
                try moveRemoteToOutboxUnlocked(item)
            }
            try unlinkArtifactsUnlocked(id)
            liveSessions.remove(id)
        }
    }

    private func moveRemoteToOutboxUnlocked(_ item: [String: Any]) throws {
        let did = item["owner"] as? String
        let remotes = (item["ledger"] as? [String: Any])?["remote"] as? [[String: Any]] ?? []
        for remote in remotes where remote["cleanup"] as? String != "done" {
            guard let did, let provider = remote["provider"] as? String else { continue }
            if let opId = remote["opId"] as? String, let id = item["id"] as? String {
                // Idempotent across a crash after the tombstone and before sidecar removal.
                try writeReceiptOutboxUnlocked(id: id, opId: opId, receipt: remote, result: remote)
                continue
            }
            let mode = remote["mode"] ?? NSNull()
            if let job = remote["jobId"] as? String {
                try enqueueOutboxUnlocked(did: did, provider: provider, mode: mode,
                                          kind: provider == "ptx" ? "ptx_job" : "transcript", handle: job)
            }
            if provider == "assemblyai", mode as? String == "hosted",
               let upload = remote["uploadId"] as? String {
                try enqueueOutboxUnlocked(did: did, provider: provider, mode: mode,
                                          kind: "hosted_upload", handle: upload)
            }
            if provider == "assemblyai", mode as? String == "own",
               remote["stage"] as? String == "submit_unknown",
               remote["jobId"] == nil, let url = remote["uploadUrl"] as? String {
                try enqueueOutboxUnlocked(did: did, provider: provider, mode: mode,
                                          kind: "own_upload_lookup", handle: url)
            }
        }
    }

    private func enqueueOutboxUnlocked(did: String, provider: String, mode: Any,
                                       kind: String, handle: String) throws {
        try check("delete.outbox")
        for path in try FileManager.default.contentsOfDirectory(at: url("outbox"), includingPropertiesForKeys: nil) {
            guard let data = try? Data(contentsOf: path),
                  let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if existing["did"] as? String == did && existing["provider"] as? String == provider &&
               existing["kind"] as? String == kind && existing["handle"] as? String == handle &&
               existing["mode"] as? String == mode as? String {
                return
            }
        }
        let entryId = UUID().uuidString.lowercased()
        let object: [String: Any] = ["entryId": entryId, "did": did, "provider": provider,
                                     "mode": mode, "kind": kind, "handle": handle,
                                     "createdAt": wallMilliseconds(), "attempts": 0]
        try writeDurable(CanonicalJSON.file(object), to: url("outbox/\(entryId).json"))
        try sync(url("outbox"))
    }

    private func unlinkArtifactsUnlocked(_ id: String) throws {
        try check("delete.unlink")
        for path in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        where (path.lastPathComponent == "\(id).m4a" || path.lastPathComponent.hasPrefix("\(id).")) &&
              path.lastPathComponent != "\(id).json" {
            try FileManager.default.removeItem(at: path)
        }
        let session = sessionURL(id)
        if FileManager.default.fileExists(atPath: session.path) { try FileManager.default.removeItem(at: session) }
        for path in try FileManager.default.contentsOfDirectory(at: url("staging"), includingPropertiesForKeys: nil)
        where path.lastPathComponent.hasPrefix("\(id).") { try FileManager.default.removeItem(at: path) }
        try sync(root); try sync(url("sessions")); try sync(url("staging"))
        try check("delete.sidecarRemove")
        if FileManager.default.fileExists(atPath: sidecarURL(id).path) { try FileManager.default.removeItem(at: sidecarURL(id)) }
        try sync(root)
    }

    private func retireTombstoneUnlocked(_ id: String) throws {
        guard active[id, default: 0] == 0 else { return }
        let artifacts = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .contains { $0.lastPathComponent == "\(id).m4a" || $0.lastPathComponent.hasPrefix("\(id).") }
        let staged = try FileManager.default.contentsOfDirectory(at: url("staging"), includingPropertiesForKeys: nil)
            .contains { $0.lastPathComponent.hasPrefix("\(id).") }
        guard !artifacts, !staged, !FileManager.default.fileExists(atPath: sessionURL(id).path) else { return }
        try check("tombstone.retire")
        try? FileManager.default.removeItem(at: url("tombstones/\(id)"))
        try sync(url("tombstones"))
    }

    public func listOutbox(did: String) throws -> [[String: Any]] {
        try queue.sync {
            try FileManager.default.contentsOfDirectory(at: url("outbox"), includingPropertiesForKeys: nil)
                .compactMap { path in
                    guard let data = try? Data(contentsOf: path),
                          let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          item["did"] as? String == did else { return nil }
                    return item
                }
        }
    }

    public func completeOutbox(_ entryId: String, result: String) throws {
        let separator = entryId.firstIndex(of: ":")
        let receiptID = separator.map { String(entryId[..<$0]) }
        let opID = separator.map { String(entryId[entryId.index(after: $0)...]) }
        guard (Self.validID(entryId) || receiptID.map(Self.validID) == true &&
               opID.map(Self.validOpID) == true),
              ["done", "retry", "lookup", "unknown", "authority_expired"].contains(result) else {
            throw CaptureError.invalidArgument
        }
        try queue.sync {
            let path = url("outbox/\(entryId).json")
            guard let data = try? Data(contentsOf: path),
                  var item = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw CaptureError.notFound
            }
            if result == "done" { try FileManager.default.removeItem(at: path) }
            else {
                item["attempts"] = (item["attempts"] as? Int ?? 0) + 1
                item["state"] = result == "retry" ? "pending" : result
                try writeDurable(CanonicalJSON.file(item), to: path)
            }
            try sync(url("outbox"))
        }
    }

    /// The probe is the slow operation. Delete keeps its tombstone while this generation is
    /// active, and publication rechecks it after the probe and any suspension gate.
    public func probeLegacy(_ id: String, load: () throws -> [String: Any]?) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        let generation = try beginOperation(id)
        defer { endOperation(id) }
        let item = try load()
        gate?("probe.afterLoad")
        try queue.sync {
            guard generations[id, default: 0] == generation,
                  !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
                  FileManager.default.fileExists(atPath: audioURL(id).path) else {
                throw CaptureError.tombstoned
            }
            if FileManager.default.fileExists(atPath: sidecarURL(id).path) {
                if (try? readSidecarUnlocked(id)) != nil { return }
                try FileManager.default.moveItem(at: sidecarURL(id),
                    to: url("quarantine/\(id).sidecar.json"))
                try sync(url("quarantine")); try sync(root)
            }
            if let item {
                try check("import.sidecar")
                try publishSidecarUnlocked(id, item, failpointName: "import.sidecar")
            } else {
                try quarantineUnlocked(id, reason: "no_audio_track")
            }
        }
    }

    public func quarantine(_ id: String, reason: String) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            guard !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path),
                  FileManager.default.fileExists(atPath: audioURL(id).path) else { throw CaptureError.cancelled }
            try quarantineUnlocked(id, reason: reason)
        }
    }

    private func quarantineUnlocked(_ id: String, reason: String) throws {
        let folder = url("quarantine")
        let audio = audioURL(id)
        let size = (try audio.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        try FileManager.default.moveItem(at: audio, to: folder.appendingPathComponent("\(id).m4a"))
        let details: [String: Any] = ["id": id, "reason": reason, "sizeBytes": size]
        try writeDurable(CanonicalJSON.file(details), to: folder.appendingPathComponent("\(id).json"))
        try sync(folder); try sync(root)
    }

    public func listQuarantine() throws -> [[String: Any]] {
        try queue.sync {
            try FileManager.default.contentsOfDirectory(at: url("quarantine"), includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" && Self.validID($0.deletingPathExtension().lastPathComponent) }
                .compactMap { path in
                    guard let data = try? Data(contentsOf: path),
                          var item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
                    let id = path.deletingPathExtension().lastPathComponent
                    item["sizeBytes"] = (try? url("quarantine/\(id).m4a").resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                    return item
                }
        }
    }

    public func deleteQuarantined(_ id: String) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            for ext in ["m4a", "json", "sidecar.json"] {
                let file = url("quarantine/\(id).\(ext)")
                if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            }
            try sync(url("quarantine"))
        }
    }

    public func recoverableSessions(excluding liveID: String? = nil) throws -> [String] {
        try queue.sync {
            guard !didRecover else { return [] }
            didRecover = true
            // A crashed mux can leave large partial outputs. Never touch a live id's staged work.
            for file in try FileManager.default.contentsOfDirectory(at: url("staging"), includingPropertiesForKeys: nil) {
                let id = String(file.lastPathComponent.prefix(36))
                guard Self.validID(id), id != liveID, !liveSessions.contains(id),
                      active[id, default: 0] == 0 else { continue }
                try FileManager.default.removeItem(at: file)
            }
            try sync(url("staging"))
            for tombstone in try FileManager.default.contentsOfDirectory(at: url("tombstones"), includingPropertiesForKeys: nil) {
                let id = tombstone.lastPathComponent
                do {
                    if let item = try? readSidecarUnlocked(id) { try moveRemoteToOutboxUnlocked(item) }
                    try unlinkArtifactsUnlocked(id)
                    try retireTombstoneUnlocked(id)
                } catch { /* Retain marker and retry next launch. */ }
            }
            return try FileManager.default.contentsOfDirectory(at: url("sessions"), includingPropertiesForKeys: nil)
                .map(\.lastPathComponent).filter {
                    $0 != liveID && !liveSessions.contains($0) && !startedHere.contains($0) &&
                    Self.validID($0) && !FileManager.default.fileExists(atPath: url("tombstones/\($0)").path)
                }
        }
    }

    /// Recovery may be triggered by launch or a plugin reload. Check again immediately
    /// before finalizing an id because capture can start while a sweep is in flight.
    public func isLiveCapture(_ id: String) -> Bool {
        queue.sync { liveSessions.contains(id) }
    }

    public func endLiveCapture(_ id: String) {
        queue.sync { _ = liveSessions.remove(id) }
    }

    public func adoptParkedSession(_ id: String) throws {
        try queue.sync {
            guard FileManager.default.fileExists(atPath: sessionURL(id).path),
                  !FileManager.default.fileExists(atPath: url("tombstones/\(id)").path) else {
                throw CaptureError.notFound
            }
            liveSessions.insert(id)
        }
    }

    /// Three failed launch attempts move the session out of the automatic scan. Its original
    /// journal and segments remain intact until the user explicitly retries or discards it.
    public func noteRecoveryFailure(_ id: String, reason: String) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            let marker = url("quarantine/\(id).recovery.json")
            let previous = (try? JSONSerialization.jsonObject(with: Data(contentsOf: marker))) as? [String: Any]
            let count = (previous?["attempts"] as? Int ?? 0) +
                (countedRecoveryFailures.insert(id).inserted ? 1 : 0)
            let record: [String: Any] = ["id": id, "reason": reason, "attempts": count,
                                         "quarantined": count >= 3]
            try writeDurable(CanonicalJSON.file(record), to: marker)
            try sync(url("quarantine"))
            if count >= 3, FileManager.default.fileExists(atPath: sessionURL(id).path) {
                try FileManager.default.moveItem(at: sessionURL(id), to: url("quarantine/\(id).session"))
                try sync(url("sessions")); try sync(url("quarantine"))
            }
        }
    }

    public func listRecoveryFailures() throws -> [[String: Any]] {
        try queue.sync {
            try FileManager.default.contentsOfDirectory(at: url("quarantine"), includingPropertiesForKeys: nil)
                .filter { $0.lastPathComponent.hasSuffix(".recovery.json") }
                .compactMap { path in
                    guard let data = try? Data(contentsOf: path),
                          let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = item["id"] as? String, Self.validID(id) else { return nil }
                    return item
                }
        }
    }

    public func prepareRecoveryRetry(_ id: String) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            let parked = url("quarantine/\(id).session")
            if FileManager.default.fileExists(atPath: parked.path) {
                try FileManager.default.moveItem(at: parked, to: sessionURL(id))
                try sync(url("quarantine")); try sync(url("sessions"))
            }
            guard FileManager.default.fileExists(atPath: sessionURL(id).path) else { throw CaptureError.notFound }
        }
    }

    public func clearRecoveryFailure(_ id: String) {
        queue.sync {
            countedRecoveryFailures.remove(id)
            let marker = url("quarantine/\(id).recovery.json")
            if FileManager.default.fileExists(atPath: marker.path) {
                try? FileManager.default.removeItem(at: marker)
                try? sync(url("quarantine"))
            }
        }
    }

    public func discardFailedRecording(_ id: String) throws {
        guard Self.validID(id) else { throw CaptureError.invalidArgument }
        try queue.sync {
            let parked = url("quarantine/\(id).session")
            let marker = url("quarantine/\(id).recovery.json")
            guard FileManager.default.fileExists(atPath: marker.path) else { throw CaptureError.notFound }
            if FileManager.default.fileExists(atPath: parked.path) { try FileManager.default.removeItem(at: parked) }
            if FileManager.default.fileExists(atPath: sessionURL(id).path) { try FileManager.default.removeItem(at: sessionURL(id)) }
            try FileManager.default.removeItem(at: marker)
            try sync(url("quarantine")); try sync(url("sessions"))
        }
    }

    public func markRecoveryComplete() { queue.sync { didRecover = true } }

    public func cleanupCommittedSession(_ id: String) throws {
        try queue.sync {
            guard FileManager.default.fileExists(atPath: sidecarURL(id).path) else { throw CaptureError.notFound }
            if FileManager.default.fileExists(atPath: sessionURL(id).path) {
                try FileManager.default.removeItem(at: sessionURL(id))
                try sync(url("sessions"))
            }
        }
    }
}
