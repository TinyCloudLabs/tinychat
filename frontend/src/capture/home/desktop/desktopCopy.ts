import { deviceName, type AppPlatform } from "@/lib/platform";

const WRITE_FAILED = "Couldn't save all of this recording";

/** Every line of text on the desktop Capture home that the library's own rows and the phone home do not already say. */
export const DESKTOP_HOME_COPY = {
  heading: "Capture",
  library: "Library",
  start: "Start recording",
  startLabel: "Start recording a voice note",
  back: "Back to recording",
  upload: "Upload",
  meeting: "Meeting",
  uploadLabel: "Upload audio",
  meetingLabel: "Send a notetaker to a meeting",
  connect: "Connect existing meetings",
  connected: (count: number) => `${count} connected`,
  connectUnavailable: "Connection status unavailable",
  inProgress: "In progress",
  recent: "Recent",
  filters: "Filter recent captures",
  recentEmpty: "Your recordings appear here",
  filterEmpty: { note: "No voice notes yet", meeting: "No meetings yet" },
  loadingRecent: "Loading your recent captures…",
  recentFailed: "Couldn’t load your recent captures.",
  retryRecent: "Try again",
  voiceNoteTitle: "Voice note",
  pendingOne: (where: string) => `1 voice note ${where}`,
  pendingMany: (count: number, where: string) => `${count} voice notes ${where}`,
  notInSpace: "Not in your space yet",
  saveNow: "Save now",
  manageStorage: "Manage storage",
  willFinish: (where: string) => `Kept ${where}. Exo will finish it automatically.`,
  willRetry: "Exo will retry when it next opens",
  timedOut: (where: string) => `Saving… · kept ${where}`,
  recoveryFailed: "Couldn't recover this recording",
  writeFailed: WRITE_FAILED,
  partialAudio: "Saved — part of this recording couldn't be written",
  dismiss: "Dismiss",
  dismissLabel: (title: string) => `Dismiss the notice for ${title}`,
  retry: "Retry",
  retryLabel: (title: string) => `Retry transcribing ${title} on this Mac`,
  scanFailure:
    "Exo couldn't check for unfinished recordings. It will try again when it next opens.",
} as const;

/** Where an unsaved recording is kept: the desktop app's Mac, a browser, or a phone or tablet app. */
export type HomePlace = "mac" | "browser" | "ios" | "android";

export function homePlace(platform: AppPlatform): HomePlace {
  return platform === "tauri" ? "mac" : platform === "web" ? "browser" : platform;
}

/** "on this Mac", "in this browser" or "on this device". */
export function placeWhere(place: HomePlace): string {
  return place === "browser" ? "in this browser" : `on ${deviceName(place === "mac" ? "tauri" : place)}`;
}

/** The failed-recording sheet's shared copy, which says "this phone", for the place it is kept. */
export function forPlace(place: HomePlace): (text: string) => string {
  const name = deviceName(place === "mac" ? "tauri" : place === "browser" ? "web" : place);
  const where = placeWhere(place);
  return (text) => text
    .replaceAll(/(?:on|in) this (?:Android phone|iPhone|Mac|browser|phone|device)/g, where)
    .replaceAll(/this (?:Android phone|iPhone|Mac|browser|phone|device)/g, name)
    .replaceAll(/This (?:Android phone|iPhone|Mac|browser|phone|device)/g, name.replace(/^t/, "T"));
}
