import Foundation
import CoreFoundation

public enum CaptureError: Error, Equatable, LocalizedError {
    case alreadyRecording, notRecording, invalidArgument, notFound, notFailedRecording, tombstoned
    case staleTransition, ownerMismatch, revConflict, recordingInProgress
    case insufficientStorage, noAudio, cancelled, pauseFailed, resumeFailed, io(String)
    case finalizationTimedOut(String)
    case rowIDRequired, claimEvidenceRequired, claimEvidenceInvalid

    public var code: String {
        switch self {
        case .alreadyRecording: "already_recording"
        case .notRecording: "not_recording"
        case .invalidArgument: "invalid_argument"
        case .notFound: "not_found"
        case .notFailedRecording: "not_failed_recording"
        case .tombstoned: "tombstoned"
        case .staleTransition: "stale_transition"
        case .ownerMismatch: "owner_mismatch"
        case .revConflict: "rev_conflict"
        case .recordingInProgress: "recording_in_progress"
        case .insufficientStorage: "insufficient_storage"
        case .noAudio: "no_audio_captured"
        case .cancelled: "cancelled"
        case .pauseFailed: "pause_failed"
        case .resumeFailed: "resume_failed"
        case .io: "io_failed"
        case .finalizationTimedOut: "finalization_timed_out"
        case .rowIDRequired: "row_id_required"
        case .claimEvidenceRequired: "claim_evidence_required"
        case .claimEvidenceInvalid: "claim_evidence_invalid"
        }
    }

    public var errorDescription: String? {
        if case .io(let message) = self { return message }
        if case .finalizationTimedOut(let stage) = self { return "Recording finalization timed out at \(stage)" }
        return code
    }
}

public struct CaptureOptions: Codable, Equatable {
    public var transcriber: String
    public var identifySpeakers: Bool

    public init(transcriber: String = "on-device", identifySpeakers: Bool = false) {
        self.transcriber = transcriber
        self.identifySpeakers = identifySpeakers
    }
}

public struct CaptureDefaults: Codable, Equatable {
    public var accountDid: String?
    public var transitionGen: Int64
    public var transcriber: String
    public var identifySpeakers: Bool

    public init(accountDid: String? = nil, transitionGen: Int64 = 0,
                transcriber: String = "on-device", identifySpeakers: Bool = false) {
        self.accountDid = accountDid
        self.transitionGen = transitionGen
        self.transcriber = transcriber
        self.identifySpeakers = identifySpeakers
    }

    public var options: CaptureOptions {
        CaptureOptions(transcriber: accountDid == nil ? "on-device" : transcriber,
                       identifySpeakers: identifySpeakers)
    }

    public func validateTransition(from stored: CaptureDefaults) throws {
        guard transitionGen >= stored.transitionGen else { throw CaptureError.staleTransition }
    }
}

public struct CaptureAccountState: Codable, Equatable {
    public var status: String
    public var accountDid: String?
    public var transitionGen: Int64
    public var options: CaptureOptions

    public init(status: String = "signed_out", accountDid: String? = nil,
                transitionGen: Int64 = 0, options: CaptureOptions = CaptureOptions()) {
        self.status = status
        self.accountDid = accountDid
        self.transitionGen = transitionGen
        self.options = options
    }

    public var defaults: CaptureDefaults {
        CaptureDefaults(accountDid: status == "signed_in" ? accountDid : nil,
                        transitionGen: transitionGen, transcriber: options.transcriber,
                        identifySpeakers: options.identifySpeakers)
    }
}

public struct MissingAudioSpan: Codable, Equatable {
    public var kind: String
    public var reason: String
    public var startedAt: Int64
    public var endedAt: Int64?
    public var atAudioMs: Int64
    public var audioMs: Int64

    public init(kind: String, reason: String, startedAt: Int64, atAudioMs: Int64) {
        self.kind = kind
        self.reason = reason
        self.startedAt = startedAt
        self.endedAt = nil
        self.atAudioMs = atAudioMs
        self.audioMs = 0
    }
}

public struct SessionInfo: Codable {
    public var id: String
    public var platform: String
    public var rate: Int
    public var bitrate: Int
    public var maxDurationMs: Int64
    public var source: String
    public var owner: String?
    public var transitionGen: Int64
    public var options: CaptureOptions
    public var startedAt: Int64

    public init(id: String, platform: String = "ios", rate: Int = 48_000, bitrate: Int = 64_000,
                maxDurationMs: Int64 = 10_800_000, source: String, owner: String?,
                transitionGen: Int64, options: CaptureOptions, startedAt: Int64) {
        self.id = id; self.platform = platform; self.rate = rate; self.bitrate = bitrate
        self.maxDurationMs = maxDurationMs; self.source = source; self.owner = owner
        self.transitionGen = transitionGen; self.options = options; self.startedAt = startedAt
    }

    public func journalEvent() -> [String: Any] {
        ["e": "session", "t": startedAt, "a": 0, "v": 1, "id": id, "platform": platform,
         "codec": "aac-lc", "container": "adts", "rate": rate, "channels": 1,
         "bitrate": bitrate, "maxDurationMs": maxDurationMs, "source": source,
         "owner": owner as Any? ?? NSNull(), "transitionGen": transitionGen,
         "options": ["transcriber": options.transcriber, "identifySpeakers": options.identifySpeakers]]
    }
}

public func wallMilliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// MPEG-4 AAC-LC ADTS, 48 kHz mono. Pure Swift so the exact bytes can be fixture tested.
public enum ADTS {
    public static func header(payloadBytes: Int, sampleRateIndex: UInt8 = 3) throws -> [UInt8] {
        let length = payloadBytes + 7
        guard payloadBytes > 0, length <= 0x1fff, sampleRateIndex <= 12 else {
            throw CaptureError.invalidArgument
        }
        return [0xff, 0xf1, UInt8(0x40 | (sampleRateIndex << 2)),
                UInt8(0x40 | ((length >> 11) & 0x03)),
                UInt8((length >> 3) & 0xff), UInt8(((length & 0x07) << 5) | 0x1f), 0xfc]
    }

    public static func payloadLength(_ header: [UInt8]) -> Int? {
        guard header.count >= 7, header[0] == 0xff, header[1] & 0xf0 == 0xf0 else { return nil }
        let length = (Int(header[3] & 0x03) << 11) | (Int(header[4]) << 3) | Int(header[5] >> 5)
        return length >= 7 ? length - 7 : nil
    }

    public static func fullFrameCount(_ data: Data) -> Int {
        completePrefix(data).frames
    }

    public static func completePrefix(_ data: Data) -> (frames: Int, bytes: Int) {
        var position = 0, count = 0
        while position + 7 <= data.count {
            let header = [UInt8](data.subdata(in: position..<(position + 7)))
            guard let payload = payloadLength(header), position + 7 + payload <= data.count else { break }
            position += 7 + payload
            count += 1
        }
        return (count, position)
    }
}

public enum JournalCodec {
    public static func line(_ event: [String: Any]) throws -> Data {
        var data = try CanonicalJSON.object(event)
        data.append(0x0a)
        return data
    }

    /// A truncated last line is expected after a crash and never changes earlier events.
    public static func read(_ data: Data) throws -> [[String: Any]] {
        let bytes = [UInt8](data)
        var events: [[String: Any]] = [], start = 0
        for end in bytes.indices where bytes[end] == 0x0a {
            guard end > start,
                  let item = try? JSONSerialization.jsonObject(with: Data(bytes[start..<end])) as? [String: Any] else {
                throw CaptureError.io("invalid complete journal line")
            }
            events.append(item)
            start = end + 1
        }
        return events
    }
}

public enum CanonicalJSON {
    public static func object(_ value: [String: Any]) throws -> Data {
        Data(try encode(value).utf8)
    }

    private static func encode(_ value: Any) throws -> String {
        if value is NSNull { return "null" }
        if let object = value as? [String: Any] {
            let keys = object.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
            let fields = try keys.map { key in "\(quote(key)):\(try encode(object[key]!))" }
            return "{\(fields.joined(separator: ","))}"
        }
        if let array = value as? [Any] {
            return "[\(try array.map(encode).joined(separator: ","))]"
        }
        if let string = value as? String { return quote(string) }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            guard let integer = Int64(number.stringValue), NSNumber(value: integer) == number else {
                throw CaptureError.invalidArgument
            }
            return String(integer)
        }
        throw CaptureError.invalidArgument
    }

    private static func quote(_ string: String) -> String {
        var output = "\""
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 0x22: output += "\\\""
            case 0x5c: output += "\\\\"
            case 0x08: output += "\\b"
            case 0x09: output += "\\t"
            case 0x0a: output += "\\n"
            case 0x0c: output += "\\f"
            case 0x0d: output += "\\r"
            case 0..<0x20: output += String(format: "\\u%04x", scalar.value)
            default: output.unicodeScalars.append(scalar)
            }
        }
        return output + "\""
    }

    public static func file(_ value: [String: Any]) throws -> Data {
        var data = try object(value)
        data.append(0x0a)
        return data
    }
}
