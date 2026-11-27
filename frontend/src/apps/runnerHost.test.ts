import { describe, expect, test } from "bun:test";

import { framedApp, type FramedOneApp } from "./registry";
import { readInstalledApp, RunAppError, RunnerHost, runnerSlug, type RunnerMessage } from "./runnerHost";

const enc = (text: string) => new TextEncoder().encode(text);
async function sha(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An Apps space with TinyDrive installed the way its "Install in my TinyCloud" leaves it (tinydrive web/src/drive.js). */
async function installed(appId = "xyz.tinycloud.tinydrive", change?: (records: Map<string, Uint8Array>) => void) {
  const files: Record<string, Uint8Array> = {
    "app/index.html": enc("<!doctype html><script src=app.js></script>"),
    "app/app.js": enc("console.log('hi')"),
    "app/icon-32.png": new Uint8Array([137, 80, 78, 71]),
    "app/manifest.json": enc("{}"),
    "knowledge/index.md": enc("# Drive"),
  };
  const records = new Map<string, Uint8Array>();
  const release = { app_id: appId, entry: "app/index.html", files: {} as Record<string, { sha256: string; size: number }> };
  for (const [path, bytes] of Object.entries(files)) {
    records.set(`${appId}/${path}`, bytes);
    release.files[path] = { sha256: await sha(bytes), size: bytes.length };
  }
  records.set(`${appId}/app/release.json`, enc(JSON.stringify(release)));
  records.set(`${appId}/app/install.json`, enc(JSON.stringify({ files: 5 })));
  change?.(records);
  const reads: string[] = [];
  const read = async (key: string) => {
    reads.push(key);
    const bytes = records.get(key);
    if (!bytes) throw new Error("not found");
    return bytes;
  };
  return { read, reads, records };
}

describe("runner sub-addresses", () => {
  test("Drive's frame origin is its own runner sub-address (the runner computes the same label)", async () => {
    const drive = framedApp("xyz.tinycloud.tinydrive")!;
    expect(drive.fromSpace).toBe(true);
    const label = new URL(drive.origin).hostname.split(".")[0];
    expect(label).toBe(await runnerSlug("xyz.tinycloud.tinydrive"));
    expect(label).toBe("guqda7cucxregwu3pgrwcq6syc");
  });

  test("labels are 26 base32 letters and differ per app", async () => {
    const a = await runnerSlug("xyz.tinycloud.tinydrive");
    const b = await runnerSlug("xyz.tinycloud.tinygym");
    expect(a).toMatch(/^[a-z2-7]{26}$/);
    expect(b).toMatch(/^[a-z2-7]{26}$/);
    expect(a).not.toBe(b);
  });
});

describe("readInstalledApp", () => {
  test("hands over the app/ files only, checked, with types; never the install records or knowledge", async () => {
    const { read } = await installed();
    const app = await readInstalledApp(read, "xyz.tinycloud.tinydrive");
    expect(app.entry).toBe("index.html");
    expect(app.files.map((file) => file.path).sort()).toEqual(["app.js", "icon-32.png", "index.html", "manifest.json"]);
    expect(app.files.find((file) => file.path === "app.js")!.type).toBe("text/javascript");
    expect(app.files.find((file) => file.path === "icon-32.png")!.type).toBe("image/png");
    expect(new TextDecoder().decode(app.files.find((file) => file.path === "app.js")!.body)).toBe("console.log('hi')");
  });

  test("an install that never finished (no install.json) does not run", async () => {
    const { read } = await installed(undefined, (records) => records.delete("xyz.tinycloud.tinydrive/app/install.json"));
    await expect(readInstalledApp(read, "xyz.tinycloud.tinydrive")).rejects.toMatchObject({ reason: "not-installed" });
  });

  test("a file changed after install does not run", async () => {
    const { read } = await installed(undefined, (records) => records.set("xyz.tinycloud.tinydrive/app/app.js", enc("fetch('https://evil')")));
    await expect(readInstalledApp(read, "xyz.tinycloud.tinydrive")).rejects.toMatchObject({ reason: "changed" });
  });

  test("a release record for another app, or with a path that climbs out, does not run", async () => {
    const other = await installed("xyz.tinycloud.other");
    other.records.set("xyz.tinycloud.tinydrive/app/install.json", enc("{}"));
    other.records.set("xyz.tinycloud.tinydrive/app/release.json", other.records.get("xyz.tinycloud.other/app/release.json")!);
    await expect(readInstalledApp(other.read, "xyz.tinycloud.tinydrive")).rejects.toBeInstanceOf(RunAppError);
    const climbing = await installed(undefined, (records) => {
      const release = JSON.parse(new TextDecoder().decode(records.get("xyz.tinycloud.tinydrive/app/release.json")!));
      release.files["app/../../secrets/x"] = { sha256: "0", size: 1 };
      records.set("xyz.tinycloud.tinydrive/app/release.json", enc(JSON.stringify(release)));
    });
    await expect(readInstalledApp(climbing.read, "xyz.tinycloud.tinydrive")).rejects.toMatchObject({ reason: "bad-release" });
  });
});

describe("RunnerHost", () => {
  const drive = framedApp("xyz.tinycloud.tinydrive")!;
  const frame = {};
  const ready = (nonce = "AAAAAAAAAAAAAAAAAAAAAA") => ({ origin: drive.origin, source: frame, data: { v: 1, type: "tc-run/ready", nonce } });

  async function host(app: FramedOneApp = drive, canRead = true) {
    const space = await installed();
    const posted: Array<{ message: RunnerMessage; transfer: ArrayBuffer[] }> = [];
    const failed: string[] = [];
    const runner = new RunnerHost({
      app,
      frameWindow: () => frame,
      post: (message, transfer) => posted.push({ message, transfer }),
      canRead: async () => canRead,
      read: space.read,
      failed: (reason) => failed.push(reason),
    });
    return { runner, posted, failed, reads: space.reads };
  }

  test("on the runner's ready: the app's files, with the runner's nonce, bodies moved", async () => {
    const { runner, posted, failed } = await host();
    await runner.handle(ready("BBBBBBBBBBBBBBBBBBBBBB"));
    expect(failed).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toMatchObject({ v: 1, type: "tc-run/files", nonce: "BBBBBBBBBBBBBBBBBBBBBB", appId: "xyz.tinycloud.tinydrive", entry: "index.html" });
    expect(posted[0].transfer).toHaveLength(posted[0].message.files.length);
  });

  test("only the app's exact origin, from its own frame, with a well-formed nonce", async () => {
    const { runner, posted, reads } = await host();
    await runner.handle({ ...ready(), origin: "https://evil.example" });
    await runner.handle({ ...ready(), source: {} });
    await runner.handle(ready("short"));
    await runner.handle({ origin: drive.origin, source: frame, data: { v: 2, type: "tc-run/ready", nonce: "AAAAAAAAAAAAAAAAAAAAAA" } });
    expect(posted).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("an app with a site of its own gets no files", async () => {
    const explorer = framedApp("xyz.tinycloud.explorer")!;
    const { runner, posted } = await host(explorer);
    await runner.handle({ origin: explorer.origin, source: frame, data: ready().data });
    expect(posted).toEqual([]);
  });

  test("the owner says Not now: nothing is read, One says why", async () => {
    const { runner, posted, failed, reads } = await host(drive, false);
    await runner.handle(ready());
    expect(posted).toEqual([]);
    expect(reads).toEqual([]);
    expect(failed).toEqual(["declined"]);
  });

  test("the runner's own failure is shown; after close nothing more is sent", async () => {
    const { runner, posted, failed } = await host();
    await runner.handle({ origin: drive.origin, source: frame, data: { v: 1, type: "tc-run/failed", nonce: "AAAAAAAAAAAAAAAAAAAAAA", reason: "this address is for another app" } });
    expect(failed).toEqual(["this address is for another app"]);
    runner.close();
    await runner.handle(ready());
    expect(posted).toEqual([]);
  });
});
