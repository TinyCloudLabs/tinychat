import { describe, expect, test } from "bun:test";

import { EXPLORER_MEETING_SOURCES } from "@/lib/connectors/meetingExplorer";
import { KIND_ICON, LIBRARY_FILTERS, libraryKind, librarySourceLabel, matchesFilter } from "./libraryKinds";

describe("libraryKinds", () => {
  test("every source the Library lists maps to a kind with an icon and a label", () => {
    for (const source of EXPLORER_MEETING_SOURCES) {
      expect(["note", "meeting", "upload"]).toContain(libraryKind(source));
      expect(KIND_ICON[libraryKind(source)]).toBeDefined();
      expect(librarySourceLabel(source).length).toBeGreaterThan(0);
    }
  });

  test("Notes are voice notes, Uploads are uploads, Meetings are every meeting source", () => {
    expect(libraryKind("exo-voice-note")).toBe("note");
    expect(libraryKind("exo-upload")).toBe("upload");
    for (const source of ["fireflies", "google-meet", "tinycloud-transcriber", "exo-local"]) expect(libraryKind(source)).toBe("meeting");
    expect(libraryKind("granola")).toBe("meeting");
  });

  test("the filter: All keeps everything; each segment keeps its kind", () => {
    expect(LIBRARY_FILTERS.map((f) => f.label)).toEqual(["All", "Notes", "Meetings", "Uploads"]);
    expect(matchesFilter("fireflies", "all")).toBe(true);
    expect(matchesFilter("exo-voice-note", "note")).toBe(true);
    expect(matchesFilter("exo-voice-note", "meeting")).toBe(false);
    expect(matchesFilter("exo-upload", "upload")).toBe(true);
  });

  test("short labels on the meta line", () => {
    expect(librarySourceLabel("tinycloud-transcriber")).toBe("Notetaker");
    expect(librarySourceLabel("exo-upload")).toBe("Upload");
    expect(librarySourceLabel("fireflies")).toBe("Fireflies");
    expect(librarySourceLabel("exo-voice-note")).toBe("Voice note");
  });
});
