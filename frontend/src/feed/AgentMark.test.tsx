// Which agent is acting: its own mark, and its platform only as the agent reported it.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDetails, AgentMark, agentProfile, markColour, markLetter, PlatformName, platformOf } from "./AgentMark";

test("the platform comes only from payload.agent; without one there is none, and nothing is guessed from a name", () => {
  expect(agentProfile(undefined)).toBeUndefined();
  expect(agentProfile({})).toBeUndefined();
  expect(agentProfile({ agent: "claude" })).toBeUndefined();
  expect(agentProfile({ agent: ["claude"] })).toBeUndefined();
  expect(agentProfile({ agent: { kind: " ", model: 4 } })).toBeUndefined();
  expect(agentProfile({ title: "Claude agent", label: "Claude" })).toBeUndefined();
  expect(agentProfile({ agent: { kind: "claude", model: "Claude Opus 5.5", runsOn: "Studio Mac mini" } })).toEqual({ platform: { name: "Claude", logo: "claude.svg", colour: "#D97757" }, model: "Claude Opus 5.5", runsOn: "Studio Mac mini" });
  // A model or place with no kind is still shown, with no platform.
  expect(agentProfile({ agent: { model: "Some model" } })).toEqual({ model: "Some model" });
});

test("known platforms are matched by kind whatever the case or spacing; any other keeps the name the agent gave, with no mark", () => {
  expect(platformOf("Claude Code")).toEqual(platformOf("claude_code"));
  expect(platformOf("GEMINI").logo).toBe("gemini.svg");
  for (const kind of ["codex", "chatgpt", "grok", "muse", "openclaw", "hermes"]) expect(platformOf(kind).logo).toBeUndefined();
  expect(platformOf("Muse").name).toBe("Muse");
  expect(platformOf("Tiny Robot 2")).toEqual({ name: "Tiny Robot 2" });
});

test("every mark a platform names is a file in public/platforms", () => {
  for (const kind of ["claude", "claude-code", "cursor", "gemini", "opencode", "perplexity"]) {
    const logo = platformOf(kind).logo;
    expect(logo).toBeDefined();
    expect(existsSync(fileURLToPath(new URL(`../../public/platforms/${logo}`, import.meta.url)))).toBe(true);
  }
});

test("an agent keeps one letter and one colour wherever it appears", () => {
  const key = JSON.stringify(["lab-trip", "Trip agent"]);
  expect(markColour(key)).toBe(markColour(JSON.stringify(["lab-trip", "Trip agent"])));
  expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(markColour)).size).toBeGreaterThan(1);
  expect(markLetter("trip agent")).toBe("T");
  expect(markLetter("  ✨ élan")).toBe("É");
  expect(markLetter("")).toBe("?");
  const html = renderToStaticMarkup(<AgentMark agentKey={key} name="Trip agent" />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain(markColour(key));
  expect(html).toContain(">T<");
});

test("a platform with a mark is read out once, by its name; one without is plain text", () => {
  const claude = renderToStaticMarkup(<PlatformName platform={platformOf("claude")} chip />);
  expect(claude).toContain('role="img" aria-label="Claude"');
  expect(claude).toContain("platforms/claude.svg");
  expect(claude).toMatch(/<span aria-hidden="true"[^>]*>Claude<\/span>/);
  const grok = renderToStaticMarkup(<PlatformName platform={platformOf("grok")} chip />);
  expect(grok).not.toContain('role="img"');
  expect(grok).toMatch(/<span class="truncate">Grok<\/span>/);
});

test("agent details show only what the page knows, and offer no Disconnect", () => {
  const full = renderToStaticMarkup(<AgentDetails name="Trip agent" profile={agentProfile({ agent: { kind: "codex", model: "GPT-5.2-Codex", runsOn: "Your laptop" } })} onOpen={() => {}} />);
  for (const row of ["What it is", "Codex", "Model", "GPT-5.2-Codex", "Runs on", "Your laptop", "It can", "Post cards to your Home and read your answers to them", "Open conversation"]) expect(full).toContain(row);
  for (const unknown of ["Connected", "Access ends", "Disconnect"]) expect(full).not.toContain(unknown);
  const bare = renderToStaticMarkup(<AgentDetails name="Backup agent" />);
  for (const row of ["What it is", "Model", "Runs on"]) expect(bare).not.toContain(row);
  expect(bare).toContain("Backup agent has not said what it is or where it runs.");
  expect(bare).not.toContain("Open conversation");
  const crew = renderToStaticMarkup(<AgentDetails name="Kiln agent" via="Studio crew" profile={agentProfile({ agent: { kind: "muse" } })} />);
  expect(crew).toContain("Posts through");
  expect(crew).toContain("Studio crew");
  expect(crew).not.toContain("Model");
});
