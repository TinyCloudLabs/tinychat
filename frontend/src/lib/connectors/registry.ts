import { FlameIcon, NotebookPenIcon, VideoIcon } from "lucide-react";

import type { ConnectorDescriptor } from "./types";
import { GRANOLA_SECRET_NAME, granolaConnectorEnabled } from "./granolaFeature";

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
    status: granolaConnectorEnabled() ? "available" : "coming-soon",
    secretName: GRANOLA_SECRET_NAME,
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
