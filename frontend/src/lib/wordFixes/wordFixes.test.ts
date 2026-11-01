import { describe, expect, test } from "bun:test";

import {
  applyWordFixesToSentences, compileWordFixes, MAX_WORD_FIX_LENGTH, MAX_WORD_FIXES, NO_WORD_FIXES, parseWordFixes,
  serializeWordFixes, withoutWordFix, withWordFix, type WordFix,
} from "./wordFixes";

const fix = (...pairs: [string, string][]) => pairs.reduce<readonly WordFix[]>((list, [find, replace]) => withWordFix(list, { find, replace }), NO_WORD_FIXES);
const apply = (list: readonly WordFix[], text: string) => compileWordFixes(list)(text);

describe("matching", () => {
  test("is case-insensitive and inserts the replacement exactly as typed", () => {
    expect(apply(fix(["tiny cloud", "TinyCloud"]), "I love Tiny Cloud and TINY CLOUD and tiny cloud.")).toBe("I love TinyCloud and TinyCloud and TinyCloud.");
    expect(apply(fix(["eliza", "$& \\1 $1"]), "ask Eliza")).toBe("ask $& \\1 $1");
  });

  test("matches whole words only", () => {
    const list = fix(["cat", "dog"]);
    expect(apply(list, "cat concat cats cat_ 9cat cat")).toBe("dog concat cats cat_ 9cat dog");
  });

  test("matches multi-word phrases across runs of whitespace", () => {
    expect(apply(fix(["tiny cloud", "TinyCloud"]), "tiny   cloud and tiny\ncloud and tiny\t cloud")).toBe("TinyCloud and TinyCloud and TinyCloud");
  });

  test("punctuation counts as a boundary", () => {
    const list = fix(["tiny cloud", "TinyCloud"]);
    expect(apply(list, "(tiny cloud), tiny cloud. \"tiny cloud\" tiny-cloud")).toBe("(TinyCloud), TinyCloud. \"TinyCloud\" tiny-cloud");
  });

  test("a find that starts or ends with punctuation matches where it stands", () => {
    expect(apply(fix(["c++", "C plus plus"]), "I like c++, and c++x")).toBe("I like C plus plus, and c++x");
    expect(apply(fix([".net", "dotnet"]), "use .net now")).toBe("use dotnet now");
  });

  test("regular expression characters in find are literal", () => {
    const list = fix(["a.b", "X"], ["(x|y)", "Y"], ["[z]", "Z"], ["q*", "Q"], ["a\\b", "B"]);
    expect(apply(list, "a.b axb (x|y) x [z] q* qqq a\\b")).toBe("X axb Y x Z Q qqq B");
  });

  test("works with Unicode letters and case folding", () => {
    const list = fix(["café", "Café"], ["ołówek", "pencil"], ["日本", "Japan"]);
    expect(apply(list, "un CAFÉ, cafés, OŁÓWEK ołówka 日本")).toBe("un Café, cafés, pencil ołówka Japan");
    expect(apply(fix(["straße", "Strasse"]), "Die STRASSE ist die Straße")).toBe("Die STRASSE ist die Strasse");
  });

  test("the longest find wins where entries overlap", () => {
    const list = fix(["tiny", "small"], ["tiny cloud", "TinyCloud"], ["tiny cloud labs", "TinyCloud Labs"]);
    expect(apply(list, "tiny cloud labs, tiny cloud, tiny")).toBe("TinyCloud Labs, TinyCloud, small");
  });

  test("replaced text is not matched again", () => {
    expect(apply(fix(["a", "b"], ["b", "c"]), "a b")).toBe("b c");
    expect(apply(fix(["cloud", "tiny cloud"]), "cloud")).toBe("tiny cloud");
  });

  test("an empty list, empty text and an empty replacement", () => {
    expect(apply(NO_WORD_FIXES, "same")).toBe("same");
    expect(apply(fix(["um", "x"]), "")).toBe("");
    expect(apply(fix(["um", ""]), "so um yes")).toBe("so  yes");
  });

  test("a 36-minute transcript is fixed in one pass of one compiled expression", () => {
    const entries = Array.from({ length: MAX_WORD_FIXES }, (_, i): [string, string] => [`term${i} word`, `Term${i}`]);
    const run = compileWordFixes(fix(...entries));
    const sentences = Array.from({ length: 4000 }, (_, i) => ({ text: `so we said term${i % 250} word and then the plan changed again today ok` }));
    const started = performance.now();
    const fixed = applyWordFixesToSentences(sentences, run);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(fixed[0]!.text).toContain("Term0 and");
    expect(sentences[0]!.text).toContain("term0 word");
  });
});

describe("the list", () => {
  test("a duplicate find (ignoring case) replaces that entry where it stands", () => {
    const list = withWordFix(fix(["a", "1"], ["b", "2"]), { find: "  A ", replace: "3" });
    expect(list).toEqual([{ find: "A", replace: "3" }, { find: "b", replace: "2" }]);
  });

  test("an empty find changes nothing; editing a find moves the entry in place", () => {
    const list = fix(["a", "1"], ["b", "2"]);
    expect(withWordFix(list, { find: "   ", replace: "x" })).toBe(list);
    expect(withWordFix(list, { find: "c", replace: "3" }, "a")).toEqual([{ find: "c", replace: "3" }, { find: "b", replace: "2" }]);
    expect(withWordFix(list, { find: "b", replace: "9" }, "a")).toEqual([{ find: "b", replace: "9" }]);
  });

  test("delete removes one entry, ignoring case", () => {
    expect(withoutWordFix(fix(["a", "1"], ["b", "2"]), "A")).toEqual([{ find: "b", replace: "2" }]);
  });

  test("limits: 200 entries and 100 characters, enforced without an error", () => {
    let list: readonly WordFix[] = NO_WORD_FIXES;
    for (let i = 0; i < MAX_WORD_FIXES + 5; i++) list = withWordFix(list, { find: `f${i}`, replace: "x" });
    expect(list.length).toBe(MAX_WORD_FIXES);
    expect(withWordFix(list, { find: "f0", replace: "changed" })[0]!.replace).toBe("changed");
    const long = withWordFix(NO_WORD_FIXES, { find: "w".repeat(150), replace: "r".repeat(150) })[0]!;
    expect(long.find.length).toBe(MAX_WORD_FIX_LENGTH);
    expect(long.replace.length).toBe(MAX_WORD_FIX_LENGTH);
  });

  test("the stored value round-trips, and anything else reads as empty", () => {
    const list = fix(["tiny cloud", "TinyCloud"], ["eliza", "Eliza"]);
    const stored = serializeWordFixes(list);
    expect(JSON.parse(stored)).toEqual({ version: 1, entries: [{ find: "tiny cloud", replace: "TinyCloud" }, { find: "eliza", replace: "Eliza" }] });
    expect(parseWordFixes(stored)).toEqual(list);
    for (const bad of [null, "", "nope", "[]", "{}", '{"entries":"x"}', '{"entries":[1,null,{"find":1}]}']) expect(parseWordFixes(bad)).toEqual([]);
    expect(parseWordFixes('{"version":1,"entries":[{"find":"","replace":"x"},{"find":"a","replace":"b"},{"find":"A","replace":"c"}]}')).toEqual([{ find: "A", replace: "c" }]);
  });
});
