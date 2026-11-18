import { FlameIcon, NotebookPenIcon, VideoIcon } from "lucide-react";

import type { ConnectorDescriptor } from "./types";
import { granolaConnectorEnabled } from "./granolaFeature";

export const CONNECTORS: ConnectorDescriptor[] = [
  {
    id: "fireflies",
    name: "Fireflies",
    description: "Meeting transcripts from Fireflies.ai.",
    status: "available",
    secretName: "FIREFLIES_API_KEY",
    source: "fireflies",
    icon: FlameIcon,
  },
  {
    id: "granola",
    name: "Granola",
    description: "Notes and transcripts from Granola.",
    // Armed by VITE_GRANOLA_CONNECTOR_ENABLED=true; coming-soon is the default
    // and the harness/test value, so flag-off never renders a Connect affordance.
    status: granolaConnectorEnabled() ? "available" : "coming-soon",
    secretName: "GRANOLA_API_KEY",
    source: "granola",
    icon: NotebookPenIcon,
  },
  {
    id: "google-meet",
    name: "Google Meet",
    description: "Google Meet transcripts and Notes by Gemini.",
    status: "available",
    secretName: "REFRESH_TOKEN",
    secretScope: "google-meet",
    source: "google-meet",
    icon: VideoIcon,
  },
];
