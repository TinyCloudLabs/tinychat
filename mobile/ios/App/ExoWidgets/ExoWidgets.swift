import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct ExoWidgets: WidgetBundle {
    var body: some Widget {
        RecordingActivityWidget()
        RecordControl()
    }
}

/// Control Center, the Lock Screen and the Action button's control list: one tap starts a voice note.
struct RecordControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "xyz.tinycloud.exo.record") {
            ControlWidgetButton(action: RecordControlIntent()) {
                Label("Record", systemImage: "mic.fill")
            }
        }
        .displayName("Record a Voice Note")
        .description("Starts recording a voice note in TinyCloud One.")
    }
}

private let recordingRed = Color(red: 1, green: 0.27, blue: 0.23)

private struct RecordingTime: View {
    let state: RecordingActivityAttributes.ContentState

    var body: some View {
        if state.phase == .recording {
            Text(state.recordingSince, style: .timer).monospacedDigit()
        } else {
            Text(Duration.seconds(state.elapsedSeconds), format: .time(pattern: .minuteSecond)).monospacedDigit()
        }
    }
}

private struct RecordingTitle: View {
    let phase: RecordingActivityAttributes.ContentState.Phase

    var body: some View {
        switch phase {
        case .recording: Text("Recording")
        case .paused: Text("Paused")
        case .interrupted: Text("Interrupted")
        }
    }
}

private struct StopButton: View {
    var body: some View {
        Button(intent: StopRecordingIntent()) {
            Label("Stop", systemImage: "stop.fill").labelStyle(.iconOnly)
        }
        .tint(recordingRed)
        .accessibilityLabel("Stop and save")
    }
}

struct RecordingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: context.state.phase == .recording ? "mic.fill" : "pause.fill")
                    .foregroundStyle(recordingRed)
                    .font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    RecordingTitle(phase: context.state.phase).font(.headline)
                    Text("TinyCloud One").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                RecordingTime(state: context.state).font(.title2.weight(.semibold))
                StopButton()
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label { RecordingTitle(phase: context.state.phase) } icon: { Image(systemName: "mic.fill") }
                        .foregroundStyle(recordingRed)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RecordingTime(state: context.state).font(.title3.weight(.semibold))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text("TinyCloud One").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        StopButton()
                    }
                }
            } compactLeading: {
                Image(systemName: "mic.fill").foregroundStyle(recordingRed)
            } compactTrailing: {
                RecordingTime(state: context.state).frame(maxWidth: 52)
            } minimal: {
                Image(systemName: "mic.fill").foregroundStyle(recordingRed)
            }
        }
    }
}
