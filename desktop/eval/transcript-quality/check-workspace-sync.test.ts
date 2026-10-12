import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { assertDependencyParity, closure, type ClosureEntry } from "./check-workspace-sync";

const pkg = (name: string, version = "0.1.0"): ClosureEntry => ({
  name, version, source: null, checksum: null, manifestPath: "/workspace/shared/Cargo.toml",
  dependencies: [], features: ["default"],
});

test("a version skew in a shared transcription dependency fails parity", () => {
  const shared = ["whisper-local", "transcribe-whisper-local", "audio-chunking",
    "exo-local-transcription", "whisper-rs", "whisper-rs-sys"].map(name => pkg(name));
  const evalClosure = [...shared, pkg("owhisper-client", "0.0.2"), pkg("data")];
  const appClosure = [...shared, pkg("owhisper-client", "0.0.1"), pkg("earshot")];
  expect(() => assertDependencyParity(evalClosure, appClosure))
    .toThrow(/dependency parity: owhisper-client 0\.0\.2 .* is absent from the app closure/);
});

test("an unlisted accelerator feature fails Linux parity", () => {
  const names = ["whisper-local", "transcribe-whisper-local", "audio-chunking",
    "exo-local-transcription", "whisper-rs", "whisper-rs-sys"];
  const evalClosure = names.map(name => pkg(name));
  const appClosure = names.map(name => ({
    ...pkg(name), features: name === "whisper-local" ? ["cuda", "default", "metal"] : ["default"],
  }));
  expect(() => assertDependencyParity(evalClosure, appClosure, "linux"))
    .toThrow(/feature parity \(linux\): whisper-local .*cuda/);
});

// Cargo metadata resolves path packages by manifest, while the lockfile records
// only name/version for them. Model both inputs, including a nested dependency,
// rather than injecting a fabricated manifestPath into ClosureEntry directly.
function resolvedClosure(fork: string | null = null, simd = false): ClosureEntry[] {
  const desktop = resolve(import.meta.dir, "../..");
  const manifests: Record<string, string> = {
    "transcribe-whisper-local": resolve(desktop, "vendor/anarlog-transcribe-whisper-local/Cargo.toml"),
    "mp3": resolve(desktop, "Cargo.toml"),
    "owhisper-client": resolve(desktop, "Cargo.toml"),
    "exo-local-transcription": fork ?? resolve(desktop, "local-transcription/Cargo.toml"),
    "whisper-local": resolve(desktop, "vendor/anarlog-whisper-local/Cargo.toml"),
    "audio-chunking": resolve(desktop, "vendor/anarlog-audio-chunking/Cargo.toml"),
    "whisper-rs": resolve(desktop, "Cargo.toml"),
    "whisper-rs-sys": resolve(desktop, "Cargo.toml"),
    "symphonia-core": resolve(desktop, "Cargo.toml"),
  };
  const source = "registry+https://github.com/rust-lang/crates.io-index";
  const packages = Object.entries(manifests).map(([name, manifest_path]) => ({
    id: name === "symphonia-core" ? `${source}#symphonia-core@0.5.4` : `path+file://${manifest_path}#${name}@0.1.0`,
    name, version: name === "symphonia-core" ? "0.5.4" : "0.1.0",
    source: name === "symphonia-core" ? source : null, manifest_path,
  }));
  const byName = Object.fromEntries(packages.map(pkg => [pkg.name, pkg])) as Record<string, (typeof packages)[number]>;
  const nodes = packages.map(pkg => ({
    id: pkg.id,
    dependencies: (pkg.name === "exo-local-transcription" ? ["transcribe-whisper-local", "whisper-local", "audio-chunking", "whisper-rs", "whisper-rs-sys"]
      : pkg.name === "mp3" ? ["symphonia-core"] : []).map(name => byName[name].id),
    features: pkg.name === "symphonia-core" && simd ? ["default", "opt-simd"] : ["default"],
  }));
  const lock = { package: packages.map(pkg => ({
    name: pkg.name, version: pkg.version, ...(pkg.source ? { source: pkg.source, checksum: "a".repeat(64) } : {}),
  })) };
  return closure(lock, { packages, resolve: { nodes } }, "Cargo.lock");
}

test("forking the app exo-local-transcription path fails despite identical lockfile identity", () => {
  const evalClosure = resolvedClosure();
  const fork = resolve(import.meta.dir, "fixture-build/Cargo.toml");
  const appClosure = resolvedClosure(fork);
  const expectedPath = "local-transcription/Cargo.toml";
  expect(evalClosure.find(pkg => pkg.name === "exo-local-transcription")?.manifestPath).toBe(expectedPath);
  expect(evalClosure.find(pkg => pkg.name === "exo-local-transcription")?.dependencies
    .find(pkg => pkg.name === "transcribe-whisper-local")?.manifestPath)
    .toBe("vendor/anarlog-transcribe-whisper-local/Cargo.toml");
  expect(() => assertDependencyParity(evalClosure, appClosure))
    .toThrow(new RegExp(`dependency parity: exo-local-transcription 0\\.1\\.0 .*manifest ${expectedPath}.*absent from the app closure`));
});

test("eval-only symphonia-core opt-simd fails shared-package feature subset", () => {
  const evalClosure = resolvedClosure(null, true);
  const appClosure = resolvedClosure();
  expect(() => assertDependencyParity(evalClosure, appClosure, "linux"))
    .toThrow(/feature parity \(linux\): symphonia-core eval-only=\[opt-simd\]/);
});
