import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDist, eagerChunks, finalOnlyCss, precacheUrls } from "./flag-off-bundle-check";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true }); });

function dist(options: { precache: string[]; entryImports?: string[] }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flag-off-bundle-"));
  made.push(dir);
  mkdirSync(path.join(dir, "assets"));
  const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text);
  write("index.html", '<script type="module" src="/assets/index-A.js"></script><link rel="stylesheet" href="/assets/index-A.css">');
  write("assets/index-A.js", `${(options.entryImports ?? []).map((file) => `import"./${file}";`).join("")}const lazy=()=>import("./final-Lazy-B.js");`);
  write("assets/index-A.css", "");
  write("assets/final-Lazy-B.js", 'const css="assets/Lazy-C.css";');
  write("assets/final-Other-D.js", "");
  write("assets/Lazy-C.css", "");
  write("sw.js", `precacheAndRoute([${options.precache.map((url) => `{url:"${url}",revision:null}`).join(",")}])`);
  return dir;
}

const SHELL = ["index.html", "assets/index-A.js", "assets/index-A.css"];
const FINAL = ["assets/final-Lazy-B.js", "assets/final-Other-D.js", "assets/Lazy-C.css"];

describe("flag-off bundle check", () => {
  test("reads the precache urls and the CSS only final chunks name", () => {
    expect(precacheUrls('x([{url:"a.js",revision:null},{url:"b/c.css",revision:"1"}])')).toEqual(["a.js", "b/c.css"]);
    expect(finalOnlyCss(dist({ precache: [] }))).toEqual(["assets/Lazy-C.css"]);
  });

  test("a flag-off shell without final chunks passes", () => {
    expect(checkDist(dist({ precache: SHELL }), "off")).toEqual([]);
  });

  test("flag off: a precached final chunk or final CSS fails", () => {
    const problems = checkDist(dist({ precache: [...SHELL, "assets/final-Lazy-B.js", "assets/Lazy-C.css"] }), "off");
    expect(problems).toEqual([
      "assets/final-Lazy-B.js is precached with the recorder flag off",
      "assets/Lazy-C.css is precached with the recorder flag off",
    ]);
  });

  test("flag off: a final chunk the entry imports statically fails", () => {
    const dir = dist({ precache: SHELL, entryImports: ["final-Other-D.js"] });
    expect([...eagerChunks(dir)]).toContain("assets/final-Other-D.js");
    expect(checkDist(dir, "off")).toEqual(["assets/final-Other-D.js loads eagerly (index.html imports it statically) with the recorder flag off"]);
  });

  test("the notes WASM and the Tauri window chunk are never precached", () => {
    const problems = checkDist(dist({ precache: [...SHELL, "assets/franken_markdown_bg-X.wasm", "assets/tauri-window-Y.js"] }), "off");
    expect(problems).toHaveLength(2);
  });

  test("flag on: every final chunk must be precached", () => {
    expect(checkDist(dist({ precache: [...SHELL, ...FINAL] }), "on")).toEqual([]);
    expect(checkDist(dist({ precache: SHELL }), "on")).toHaveLength(3);
  });

  test("a build with no final chunk at all means the naming rule broke", () => {
    const dir = dist({ precache: SHELL });
    rmSync(path.join(dir, "assets/final-Lazy-B.js"));
    rmSync(path.join(dir, "assets/final-Other-D.js"));
    expect(checkDist(dir, "off")[0]).toContain("no final-* chunk");
  });
});
