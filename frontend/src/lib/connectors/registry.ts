import { FlameIcon, NotebookPenIcon, VideoIcon } from "lucide-react";

import type { ConnectorDescriptor } from "./types";

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
    // The sync flag does not enable connection setup. Granola needs its own dialog first.
    status: "coming-soon",
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
