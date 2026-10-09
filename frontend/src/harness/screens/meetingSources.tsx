import { useMemo } from "react";
import { MeetingSourcesFeature } from "@/capture/meetingSources/MeetingSourcesDialog";
import type { HarnessScreen } from "../screen";
import { createRuntimeShim } from "../runtimeShim";

function MeetingSourcesHarness({ initialOpen = false }: { initialOpen?: boolean }) {
  const shim = useMemo(() => createRuntimeShim(), []);
  return <MeetingSourcesFeature initialOpen={initialOpen} tcw={shim.tcw} backendUrl="https://example.invalid" sessionStore={shim.sessionStore} />;
}

export const meetingSourcesScreens: HarnessScreen[] = [
  { id: "meeting-sources-dialog", group: "meetingSources", layout: "pane", path: "/chat/connectors", platform: "web", readyWhen: 'button[aria-label="Close"]', render: () => <MeetingSourcesHarness /> },
  { id: "meeting-sources-dialog-open", group: "meetingSources", layout: "pane", path: "/chat/connectors/open", platform: "web", readyWhen: '[role="dialog"]', render: () => <MeetingSourcesHarness initialOpen /> },
];
