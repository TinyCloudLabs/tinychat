import { useMemo } from "react";
import { MeetingSourcesFeature } from "@/capture/meetingSources/MeetingSourcesDialog";
import type { HarnessScreen } from "../screen";
import { createRuntimeShim } from "../runtimeShim";

function MeetingSourcesHarness() {
  const shim = useMemo(() => createRuntimeShim(), []);
  return <MeetingSourcesFeature initialOpen tcw={shim.tcw} backendUrl="https://example.invalid" sessionStore={shim.sessionStore} />;
}

export const meetingSourcesScreens: HarnessScreen[] = [
  { id: "meeting-sources-dialog", group: "meetingSources", layout: "pane", path: "/chat/connectors", platform: "web", readyWhen: '[role="dialog"]', render: () => <MeetingSourcesHarness /> },
];
