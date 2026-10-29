import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const children = new Set<ReturnType<typeof Bun.spawn>>();
const servers = new Set<ReturnType<typeof Bun.serve>>();
const directories = new Set<string>();
afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  for (const server of servers) await server.stop(true);
  servers.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

for (const mode of ["fresh", "committed"] as const) {
  test(`cold Private cancellation retains its producer and both restart controls (${mode} transcript)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc2180-recovery-"));
    directories.add(directory);
    for (const name of ["home", "tc", "courier", "cache", "bun", "tmp"]) await mkdir(join(directory, name));
    const did = `did:test:${crypto.randomUUID()}`;
    let stage = "warm";
    const oldGets: Record<string, number> = { warm: 0, cold: 0 };
    let otherGets = 0;
    let creates = 0;
    let cancels = 0;
    const stopped = new Set<string>();
    const producers = new Map<string, { abort: AbortController; stream?: ReadableStreamDefaultController<Uint8Array> }>();
    const unexpected: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.headers.get("Authorization") !== "Bearer synthetic-session") {
        unexpected.push("unauthenticated request"); return new Response(null, { status: 401 });
      }
      if (path.endsWith("/capabilities")) return Response.json(path.includes("assemblyai")
        ? { hosted: true, max_bytes: 1000000, content_types: ["audio/wav"], part_size: 1024 }
        : { max_bytes: 1000000, max_duration_seconds: 100, content_types: ["audio/wav"], admission: "open" });
      if (path.endsWith("/hosted/transcripts/old-handle")) {
        oldGets[stage]!++;
        return Response.json({ id: "old-handle", status: "error", error: "Earlier synthetic Powerful failure" });
      }
      if (path.endsWith("/hosted/transcripts/other-handle")) {
        otherGets++;
        return Response.json({ id: "other-handle", status: "error", error: "Unrelated synthetic Powerful failure" });
      }
      if (request.method === "POST" && path.endsWith("/private-cloud/transcriptions")) {
        const id = `trn_${String.fromCharCode(65 + creates++).repeat(26)}`;
        producers.set(id, { abort: new AbortController() });
        return Response.json({ id, status: "completed", upload: null }, { status: 201 });
      }
      const match = path.match(/\/private-cloud\/transcriptions\/(trn_[0-9A-Z]{26})(\/.*)?$/);
      if (match) {
        const id = match[1]!;
        const producer = producers.get(id)!;
        if (match[2] === "/cancel" && request.method === "POST") {
          cancels++; producer.abort.abort(); stopped.add(id);
          try { producer.stream?.close(); } catch { /* The decoder HTTP request may already have been aborted. */ }
          return Response.json({ id, status: "cancelled" });
        }
        if (match[2] === "/result") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          producer.stream = controller;
          controller.enqueue(new TextEncoder().encode("{"));
        } }), { headers: { "Content-Type": "application/json" } });
        if (!match[2]) return Response.json({ id, status: "completed" });
      }
      unexpected.push(`${request.method} ${path}`);
      return new Response(null, { status: 404 });
    } });
    servers.add(server);
    const summaries: Array<{ pid: number; provider: string; kind: string; viewProvider: string; bothActionsEnabled: boolean }> = [];
    for (stage of ["warm", "cold"]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install",
        new URL("./transcriptionCancellation.recovery.fixture.ts", import.meta.url).pathname,
        directory, server.url.origin, stage, mode, did], {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "test", HOME: join(directory, "home"),
          TC_HOME: join(directory, "tc"), COURIER_HOME: join(directory, "courier"), XDG_CACHE_HOME: join(directory, "cache"),
          BUN_INSTALL_CACHE_DIR: join(directory, "bun"), TMPDIR: join(directory, "tmp") },
        stdout: "pipe", stderr: "pipe", timeout: 10000,
      });
      children.add(child);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      children.delete(child);
      expect({ stage, exitCode, diagnostics: exitCode ? `${stdout}\n${stderr}` : "" }).toEqual({ stage, exitCode: 0, diagnostics: "" });
      const line = stdout.split("\n").find((row) => row.startsWith("RECOVERY_RESULT "))!;
      summaries.push(JSON.parse(line.slice("RECOVERY_RESULT ".length)));
    }
    expect(summaries[0]!.pid).not.toBe(summaries[1]!.pid);
    for (const summary of summaries) expect(summary).toMatchObject({ provider: "private", kind: "cancelled", viewProvider: "private", bothActionsEnabled: true });
    expect(oldGets).toEqual({ warm: 1, cold: 0 });
    expect(otherGets).toBe(1);
    expect(creates).toBe(3);
    expect(cancels).toBe(3);
    expect(stopped.size).toBe(3);
    expect([...producers.values()].every((producer) => producer.abort.signal.aborted)).toBe(true);
    expect(unexpected).toEqual([]);
  }, 30000);
}
