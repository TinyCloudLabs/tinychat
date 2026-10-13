import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct ExoWidgets: WidgetBundle {
    var body: some Widget {
        ExoProbeActivityWidget()
        ExoProbeControl()
    }
}

struct ExoProbeControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "xyz.tinycloud.exo.probe") {
            ControlWidgetButton(action: ProbeIntent()) {
                Label("Exo probe", systemImage: "waveform")
            }
        }
        .displayName("Exo probe")
        .description("Start a signing and intent-routing probe.")
    }
}

struct ExoProbeActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            HStack {
                Text("Exo \(context.state.phase) \(context.state.count)")
                Button(intent: ProbeIntent(phase: .update)) { Image(systemName: "arrow.clockwise") }
                Button(intent: ProbeIntent(phase: .end)) { Image(systemName: "stop.fill") }
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { Text("Exo \(context.state.phase) \(context.state.count)") }
                DynamicIslandExpandedRegion(.trailing) {
                    Button(intent: ProbeIntent(phase: .end)) { Image(systemName: "stop.fill") }
                }
            } compactLeading: {
                Image(systemName: "waveform")
            } compactTrailing: {
                Text("\(context.state.count)")
            } minimal: {
                Image(systemName: "waveform")
            }
        }
    }
}
