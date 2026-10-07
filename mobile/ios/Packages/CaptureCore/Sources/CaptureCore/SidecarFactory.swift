import Foundation

public enum SidecarFactory {
    public static func v2(session: SessionInfo, durationMs: Int64, wallMs: Int64,
                          pausedMs: Int64, spans: [MissingAudioSpan], input: [String: Any]?,
                          recovered: Bool, endedUnexpectedly: Bool,
                          lastHeartbeatAt: Int64?) -> [String: Any] {
        let silenced = spans.filter { $0.kind == "silenced" }
        return [
            "id": session.id, "startedAt": session.startedAt, "durationMs": durationMs,
            "mimeType": "audio/mp4", "sizeBytes": 0, "silencedMs": silenced.reduce(0) { $0 + $1.audioMs },
            "silencedEvents": silenced.count, "noSignalMs": 0,
            "version": 2, "rev": 1, "wallMs": wallMs, "pausedMs": pausedMs,
            "spans": spans.map { span in
                ["kind": span.kind, "reason": span.reason, "startedAt": span.startedAt,
                 "endedAt": span.endedAt as Any? ?? NSNull(), "atAudioMs": span.atAudioMs,
                 "audioMs": span.audioMs] as [String: Any]
            },
            "recovered": recovered, "endedUnexpectedly": endedUnexpectedly,
            "lastHeartbeatAt": lastHeartbeatAt as Any? ?? NSNull(), "exitReason": NSNull(),
            "legacyImport": false, "ownerUnknown": false,
            "source": session.source, "owner": session.owner as Any? ?? NSNull(),
            "transitionGen": session.transitionGen,
            "options": ["transcriber": session.options.transcriber,
                        "identifySpeakers": session.options.identifySpeakers],
            "input": input as Any? ?? NSNull(), "sampleRate": session.rate, "bitrate": session.bitrate,
            "ledger": [
                "spaceId": NSNull(),
                "audio": ["state": "pending", "rowId": NSNull(), "at": NSNull()],
                "transcript": ["state": "pending", "outcome": NSNull(), "reason": NSNull(),
                               "attempts": 0, "nextAttemptAt": NSNull()],
                "transcriptSync": ["state": "pending", "rev": 0, "at": NSNull()],
                "landed": ["state": "none", "eventId": NSNull()],
                "remote": []
            ],
            "stt": ["state": "waiting_for_model", "pack": NSNull(), "engine": NSNull(),
                    "segmentsDone": 0, "windowsDone": 0, "error": NSNull()]
        ]
    }
}
