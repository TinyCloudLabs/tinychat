import { describe, expect, test } from "bun:test";

import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";

import { buildNamingPrompt } from "./namingPrompt";
import { agreeOnNames, candidateFor } from "./parseNaming";

const said = (speaker_name: string, text: string, start_time: number): FirefliesSentence =>
  ({ index: start_time, speaker_name, text, start_time, end_time: start_time + 20 });

const SENTENCES = [
  said("Me", "Welcome. With me is Timo Varella, hello Timo.", 0),
  said("Speaker 1", "Thanks. I'm Timo, I run the lab.", 20),
  said("Speaker 2", "And my name is Asha.", 40),
];
const CANDIDATES = ["Timo Varela", "Asha Raman", "Sarah Smith"];
const ALL = new Set(["Me", "Speaker 1", "Speaker 2"]);
const prompt = buildNamingPrompt(SENTENCES, CANDIDATES);

/** One reading: S-label -> [name, quote]. */
const reading = (speakers: Record<string, [string | null, string]>): string => JSON.stringify({ speakers:
  Object.entries(speakers).map(([speaker, [name, quote]]) => ({ speaker, name, basis: name ? "introduced" : "none", quote })) });
const TIMO: [string, string] = ["Timo Varella", "With me is Timo Varella, hello Timo."];

describe("agreeOnNames", () => {
  test("a name two of three readings give is kept, in the candidate's spelling, under the stored label", () => {
    const outcome = agreeOnNames([
      reading({ S1: [null, ""], S2: TIMO, S3: ["Asha", "my name is Asha"] }),
      `Here is the answer:\n\`\`\`json\n${reading({ S2: TIMO, S3: [null, ""] })}\n\`\`\``,
      reading({ S2: ["Sarah Smith", "hello Timo"], S3: [null, ""] }),
    ], prompt, CANDIDATES, ALL);
    expect(outcome).toEqual({ ok: true, names: { "Speaker 1": { name: "Timo Varela", basis: "introduced", quote: "With me is Timo Varella, hello Timo." } } });
  });

  test("a name whose quote is not in the transcript does not count", () => {
    const invented: [string, string] = ["Asha Raman", "This is Asha Raman speaking"];
    const outcome = agreeOnNames([reading({ S3: invented }), reading({ S3: invented }), reading({ S3: ["Asha Raman", "AND MY NAME — is Asha!"] })],
      prompt, CANDIDATES, ALL);
    expect(outcome).toEqual({ ok: true, names: {} });
  });

  test("with fewer than two readable answers there is no outcome at all", () => {
    expect(agreeOnNames([reading({ S2: TIMO }), "I cannot help with that.", "{\"speakers\": 3}"], prompt, CANDIDATES, ALL)).toEqual({ ok: false });
    expect(agreeOnNames([reading({ S2: TIMO })], prompt, CANDIDATES, ALL)).toEqual({ ok: false });
  });

  test("only labels that may get a suggestion do, and a label is never offered a generic label as a name", () => {
    const answers = Array.from({ length: 3 }, () => reading({ S1: ["Speaker 4", "Welcome"], S2: TIMO, S3: ["Them", "my name is Asha"] }));
    expect(agreeOnNames(answers, prompt, CANDIDATES, ALL)).toEqual({ ok: true, names: { "Speaker 1": expect.objectContaining({ name: "Timo Varela" }) } });
    expect(agreeOnNames(answers, prompt, CANDIDATES, new Set(["Speaker 2"]))).toEqual({ ok: true, names: {} });
  });

  test("a name is cleaned like a typed one, and readings that differ only in case agree", () => {
    const long = `Dr ${"Long ".repeat(30)}Name`;
    const outcome = agreeOnNames([
      reading({ S2: [long, "I run the lab"], S3: ["asha", "my name is Asha"] }),
      reading({ S2: [long, "I run the lab"], S3: ["ASHA", "my name is Asha"] }),
    ], buildNamingPrompt(SENTENCES, []), [], ALL);
    if (!outcome.ok) throw new Error("expected an outcome");
    expect(outcome.names["Speaker 1"]!.name).toHaveLength(80);
    expect(outcome.names["Speaker 2"]!.name).toBe("asha");
  });
});

describe("candidateFor", () => {
  test("takes the listed spelling for a near match, a title aside", () => {
    expect(candidateFor("Timo Varella", CANDIDATES)).toBe("Timo Varela");
    expect(candidateFor("Daniel Kerr", ["Sir Daniel Kerr", "Nadia Wolfe"])).toBe("Sir Daniel Kerr");
    expect(candidateFor("José Pena Diaz", ["José Peña Díaz"])).toBe("José Peña Díaz");
  });

  test("a lone name means a candidate only when exactly one has it", () => {
    expect(candidateFor("Asha", CANDIDATES)).toBe("Asha Raman");
    expect(candidateFor("Smith", [...CANDIDATES, "Emma Smith"])).toBe("Smith");
    expect(candidateFor("Olga", CANDIDATES)).toBe("Olga");
  });
});
