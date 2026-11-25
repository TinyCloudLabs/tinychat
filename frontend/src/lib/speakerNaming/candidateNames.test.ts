import { describe, expect, test } from "bun:test";

import { CANDIDATE_WINDOW_DAYS, candidateNames, MAX_CANDIDATE_NAMES, readCandidateNames } from "./candidateNames";
import { CALL, namingSpace } from "./namingSpace.fixture";

const people = (...names: string[]) => names.map((name) => ({ name, email: null }));

describe("candidate names", () => {
  test("the people of this call come first, then the note's earlier names, typed names, people in an overlapping meeting, and the most frequent", () => {
    expect(candidateNames({
      call: ["Robin Sample", "Alex Example"],
      earlier: ["Dana Ruiz"],
      named: ["Sam", "Alice, Bob"],
      meetings: [
        { participants: ["Rare Person", "Often Seen"], overlaps: false },
        { participants: ["In The Call"], overlaps: true },
        { participants: ["Often Seen"], overlaps: false },
      ],
    })).toEqual(["Robin Sample", "Alex Example", "Dana Ruiz", "Sam", "Alice", "Bob", "In The Call", "Often Seen", "Rare Person"]);
  });

  test("labels, email addresses and phone numbers are not names, and a name is listed once whatever its case", () => {
    expect(candidateNames({
      call: ["bob stone", "Participant 2"],
      earlier: ["Speaker 2", "alice chen"],
      named: ["Them", "ALICE CHEN", "  Bob   Stone "],
      meetings: [{ participants: ["bob@example.com", "+1 415 555 0100", "Unknown speaker", "Bob Stone", "Participant 3", "Carol"], overlaps: true }],
    })).toEqual(["bob stone", "alice chen", "Carol"]);
  });

  test("at most 60 names, the first by the order of the sources", () => {
    const names = candidateNames({
      call: [],
      earlier: ["First"],
      named: Array.from({ length: 80 }, (_, i) => `Typed ${i}`),
      meetings: [{ participants: ["From A Meeting"], overlaps: true }],
    });
    expect(names).toHaveLength(MAX_CANDIDATE_NAMES);
    expect(names.slice(0, 2)).toEqual(["First", "Typed 0"]);
    expect(names).not.toContain("From A Meeting");
  });
});

describe("candidate names from the space", () => {
  const NOTE = { call: ["Robin Sample"], earlier: ["Dana Ruiz"], startedAt: "2026-11-20T10:00:00.000Z", durationSecs: 1800 };

  test("reads typed names from every row and participants of the connectors' meetings in the 180 days before the note", async () => {
    const space = namingSpace();
    await space.note("other-note", CALL, { startedAt: "2026-11-01T09:00:00.000Z" });
    space.setMetadata("other-note", { speaker_names: { Me: "Roman", Them: "Alice Chen, Bob Stone" } });
    space.meeting("fireflies", "overlap", "2026-11-20T09:50:00.000Z", 3600, people("Erin Overlap", "erin@example.com"));
    space.meeting("google-meet", "weekly-1", "2026-11-10T10:00:00.000Z", 1800, people("Often Seen", "Once Seen"));
    space.meeting("granola", "weekly-2", "2026-11-03T10:00:00.000Z", 1800, people("Often Seen"));
    // Outside the window, after the note, and from a source that is not a connector's meeting: none of these count.
    space.meeting("fireflies", "old", new Date(Date.parse(NOTE.startedAt) - (CANDIDATE_WINDOW_DAYS + 2) * 86_400_000).toISOString(), 1800, people("Too Old"));
    space.meeting("fireflies", "later", "2026-11-20T12:00:00.000Z", 1800, people("Came Later"));
    space.meeting("tinycloud-transcriber", "bot", "2026-11-19T10:00:00.000Z", 1800, people("Not A Connector"));

    expect(await readCandidateNames(space.tcw, NOTE)).toEqual(
      ["Robin Sample", "Dana Ruiz", "Roman", "Alice Chen", "Bob Stone", "Erin Overlap", "Often Seen", "Once Seen"]);
  });

  test("no query returns a row's whole metadata", async () => {
    const space = namingSpace();
    await space.note("other-note", CALL);
    space.meeting("fireflies", "m", "2026-11-20T09:50:00.000Z", 3600, people("Erin"), { transcript_text: "fifty kilobytes of words" });
    const before = space.statements.length;
    await readCandidateNames(space.tcw, NOTE);
    const queries = space.statements.slice(before);
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      const selected = query.slice(0, query.indexOf(" FROM "));
      expect(selected.replaceAll(/json_extract\(metadata, '\$\.speaker_names'\)/g, "")).not.toContain("metadata");
      expect(selected).not.toContain("*");
    }
  });

  test("a note with no start time still gets the typed names", async () => {
    const space = namingSpace();
    await space.note("other-note", CALL);
    space.setMetadata("other-note", { speaker_names: { "Speaker 1": "Alice Chen" } });
    space.meeting("fireflies", "m", "2026-11-20T09:50:00.000Z", 3600, people("Erin"));
    expect(await readCandidateNames(space.tcw, { call: [], earlier: [], startedAt: null, durationSecs: null })).toEqual(["Alice Chen"]);
  });

  test("a space that cannot be read fails the read", async () => {
    const tcw = { sql: { db: () => ({ query: async () => ({ ok: false, error: { code: "X", message: "down" } }) }) } };
    await expect(readCandidateNames(tcw as never, NOTE)).rejects.toThrow("down");
  });
});
