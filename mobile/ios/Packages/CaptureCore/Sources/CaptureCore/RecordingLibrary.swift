import Foundation
import Darwin

/// All metadata publications go through one synchronous queue. Muxing and probing run outside it,
/// holding an operation generation that delete/discard can invalidate at any time.
public final class RecordingLibrary {
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
    public func sessionURL(_ id: String) -> URL { url("sessions/\(id)") }
    public func journalURL(_ id: String) -> URL { sessionURL(id).appendingPathComponent("journal.jsonl") }
    public func segmentURL(_ id: String, index: Int) -> URL {
        sessionURL(id).appendingPathComponent(String(format: "seg-%05d.aac", index))
    }

    public static func validID(_ id: String) -> Bool { UUID(uuidString: id) != nil && id == id.lowercased() }

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
            try sync(staged)
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
        where path.lastPathComponent == "\(id).m4a" || path.lastPathComponent.hasPrefix("\(id).") {
            try FileManager.default.removeItem(at: path)
        }
        let session = sessionURL(id)
        if FileManager.default.fileExists(atPath: session.path) { try FileManager.default.removeItem(at: session) }
        for path in try FileManager.default.contentsOfDirectory(at: url("staging"), includingPropertiesForKeys: nil)
        where path.lastPathComponent.hasPrefix("\(id).") { try FileManager.default.removeItem(at: path) }
        try sync(root); try sync(url("sessions")); try sync(url("staging"))
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
        guard Self.validID(entryId), ["done", "retry"].contains(result) else { throw CaptureError.invalidArgument }
        try queue.sync {
            let path = url("outbox/\(entryId).json")
            guard let data = try? Data(contentsOf: path),
                  var item = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw CaptureError.notFound
            }
            if result == "done" { try FileManager.default.removeItem(at: path) }
            else {
                item["attempts"] = (item["attempts"] as? Int ?? 0) + 1
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
                .filter { $0.pathExtension == "json" && !$0.lastPathComponent.hasSuffix(".sidecar.json") }
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
                .map(\.lastPathComponent).filter { $0 != liveID && !liveSessions.contains($0) && Self.validID($0) }
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
