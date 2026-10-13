import ActivityKit
import AppIntents
import Foundation
import os

enum ProbePhase: String, AppEnum {
    case start, update, end

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Probe action"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .start: "Start", .update: "Update", .end: "End"
    ]
}

struct ProbeIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Run Exo widget probe"
    static var description = IntentDescription("Checks that an Exo control reaches the app and updates a Live Activity.")
    static var openAppWhenRun = false

    @Parameter(title: "Action") var phase: ProbePhase

    init() { phase = .start }
    init(phase: ProbePhase) { self.phase = phase }

    func perform() async throws -> some IntentResult {
        let process = ProcessInfo.processInfo.processName
        Logger(subsystem: "xyz.tinycloud.exo", category: "widget-probe")
            .notice("EXO_WIDGET_PROBE phase=\(self.phase.rawValue, privacy: .public) process=\(process, privacy: .public) pid=\(getpid())")
#if EXO_WIDGET_EXTENSION
        // A LiveActivityIntent should execute in the app process. This branch makes a routing failure visible.
        return .result()
#else
        let activities = Activity<RecordingActivityAttributes>.activities
        switch phase {
        case .start:
            for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
            let content = ActivityContent(state: RecordingActivityAttributes.ContentState(phase: "started", count: 1), staleDate: nil)
            _ = try Activity.request(attributes: RecordingActivityAttributes(label: "Exo signing probe"), content: content, pushType: nil)
        case .update:
            guard let activity = activities.first else { throw ProbeError.noActivity }
            let count = activity.content.state.count + 1
            await activity.update(ActivityContent(state: .init(phase: "updated", count: count), staleDate: nil))
        case .end:
            guard let activity = activities.first else { throw ProbeError.noActivity }
            await activity.end(ActivityContent(state: .init(phase: "ended", count: activity.content.state.count), staleDate: nil), dismissalPolicy: .after(.now + 10))
        }
        return .result()
#endif
    }
}

private enum ProbeError: Error { case noActivity }

#if !EXO_WIDGET_EXTENSION
struct ExoProbeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ProbeIntent(), phrases: ["Run widget probe in \(.applicationName)"], shortTitle: "Exo probe", systemImageName: "waveform")
    }
}
#endif
