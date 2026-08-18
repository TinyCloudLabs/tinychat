import { FlameIcon, NotebookPenIcon, VideoIcon } from "lucide-react";

import type { ConnectorDescriptor } from "./types";

export const CONNECTORS: ConnectorDescriptor[] = [
  {
    id: "fireflies",
    name: "Fireflies",
    description: "Sync meeting transcripts from Fireflies.ai into your space.",
    status: "available",
    secretName: "API_KEY",
    secretScope: "fireflies",
    source: "fireflies",
    icon: FlameIcon,
  },
  {
    id: "granola",
    name: "Granola",
    description: "Sync notes and transcripts from Granola.",
    status: "coming-soon",
    secretName: "API_KEY",
    secretScope: "granola",
    source: "granola",
    icon: NotebookPenIcon,
  },
  {
    id: "google-meet",
    name: "Google Meet",
    description: "Sync Google Meet recordings and captions.",
    status: "available",
    secretName: "REFRESH_TOKEN",
    secretScope: "google-meet",
    source: "google-meet",
    icon: VideoIcon,
  },
];
