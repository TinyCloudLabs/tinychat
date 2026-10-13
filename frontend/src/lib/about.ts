// The How it works page (/chat/about) holds the explanations the screens used
// to carry inline. Screens keep a short label and link to the matching section
// here; the ids are stable anchors.
export const ABOUT_PATH = "/chat/about";

export const ABOUT_SECTIONS = [
  { id: "capture", title: "Voice notes and recording" },
  { id: "transcription", title: "Where your audio goes" },
  { id: "notetaker", title: "Meeting notetaker" },
  { id: "uploads", title: "Uploading audio" },
  { id: "library", title: "Library" },
  { id: "connectors", title: "Connectors and calendar autojoin" },
  { id: "agent-access", title: "Agent access" },
  { id: "your-data", title: "Your data and your TinyCloud space" },
  { id: "verification", title: "Model and server verification" },
] as const;

export type AboutSectionId = (typeof ABOUT_SECTIONS)[number]["id"];

export function aboutHref(section: AboutSectionId): string {
  return `${ABOUT_PATH}#${section}`;
}
