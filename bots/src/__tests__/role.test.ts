import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { botLayout, botRole } from "../layout";
import { type OciSpec, sandboxSpec } from "../oci";
import { botIdFor } from "../owner";

const roots = { dataRoot: "/data/bots", runRoot: "/run/bots", egressRoot: "/egress" };
const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const SIBLING_KEY = "0123456789abcdef0123456789abcdef";
const limits = { memoryMb: 1536, cpus: 1, pids: 256, overlayMb: 512, tmpMb: 256, stateMb: 256 };
const base: OciSpec = { ociVersion: "1.0.0", process: { args: ["sh"], env: ["PATH=/bin"], cwd: "/" }, root: { path: "rootfs" }, mounts: [] };
/** The prompt files the image copies to /opt/tinycloud/prompts. */
const PROMPTS = join(import.meta.dir, "..", "..", "sandbox", "prompts");
const BOT_START = join(import.meta.dir, "..", "..", "sandbox", "bot-start.sh");

/** The prompt file a bot's sandbox is started with, as it sits in this repository. */
function promptFileFor(botKey?: string): string {
  const layout = botLayout(botIdFor(OWNER, botKey), roots, { botKey });
  const spec = sandboxSpec(base, {
    rootfs: "/bot-rootfs", token: "t", egressDir: layout.egressDir, stateMount: layout.stateMount,
    cgroupsPath: `/bots/${layout.botId}`, limits, role: botRole(layout),
  });
  const path = spec.process?.env?.find(entry => entry.startsWith("BOT_SYSTEM_PROMPT="))?.slice("BOT_SYSTEM_PROMPT=".length);
  expect(path).toStartWith("/opt/tinycloud/prompts/");
  return join(PROMPTS, basename(path!));
}

describe("each bot starts with its own system prompt", () => {
  test("Main's sandbox is given Main's prompt", () => {
    expect(readFileSync(promptFileFor(), "utf8")).toStartWith("You are {{botName}}, the owner's main bot");
  });

  test("a sibling's sandbox is given the sibling prompt, which never points at Main's Web access setting", () => {
    const prompt = readFileSync(promptFileFor(SIBLING_KEY), "utf8");
    expect(prompt).toStartWith("You are one of the owner's bots");
    expect(prompt).not.toContain("Web access");
  });
});

describe("bot-start.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-start-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Stand-ins for socat and omp: omp prints the arguments it was started with.
  writeFileSync(join(dir, "socat"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(dir, "omp"), "#!/bin/sh\necho \"$@\"\n");
  for (const name of ["socat", "omp"]) chmodSync(join(dir, name), 0o755);

  async function ompArgs(prompt?: string): Promise<string> {
    const env: Record<string, string> = { PATH: `${dir}:/usr/bin:/bin`, TMPDIR: dir };
    if (prompt !== undefined) env.BOT_SYSTEM_PROMPT = prompt;
    const run = Bun.spawn(["sh", BOT_START], { env, stdout: "pipe", stderr: "pipe" });
    const [output] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    return output.trim();
  }

  test("starts OMP with the prompt file it is given", async () => {
    const main = join(PROMPTS, "main.md");
    expect(await ompArgs(main)).toBe(`--mode rpc --no-ui --system-prompt ${join(dir, "system-prompt.md")}`);
  });

  test("without a prompt file, starts OMP without one rather than passing a path OMP would read as the prompt", async () => {
    const missing = join(dir, "missing.md");
    expect(existsSync(missing)).toBe(false);
    expect(await ompArgs(missing)).toBe("--mode rpc --no-ui");
    expect(await ompArgs()).toBe("--mode rpc --no-ui");
  });
});
