import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// bun desktop/eval/transcript-quality/check-workspace-sync.ts [--platform linux|macos] [output.json]
const desktop = resolve(import.meta.dir, "../..");
const manifests = [resolve(desktop, "Cargo.toml"), resolve(desktop, "src-tauri/Cargo.toml")];
const locks = [resolve(desktop, "Cargo.lock"), resolve(desktop, "src-tauri/Cargo.lock")];
const roots = ["transcribe-whisper-local", "mp3", "owhisper-client", "exo-local-transcription"];
const featureParity = ["whisper-local", "transcribe-whisper-local", "audio-chunking", "exo-local-transcription", "whisper-rs", "whisper-rs-sys"];
// The eval tests pull in anarlog's sample `data` crate; it is not shipped by the app.
const evalOnlyDevDependencies: Record<string, true> = { data: true };
// The app enables Metal unconditionally. Linux compiles the CPU runner, so
// only these accelerator features may differ among the six transcription
// crates. Other shared packages allow app-only features, never eval-only ones.
// macOS checks the runner's Metal build against the app with no exceptions.
const linuxAcceleratorFeatures: Record<string, readonly string[]> = {
  "whisper-local": ["metal"],
  "transcribe-whisper-local": ["metal"],
  "whisper-rs": ["_gpu", "metal"],
  "whisper-rs-sys": ["metal"],
};
type Platform = "linux" | "macos";

type Table = Record<string, unknown>;
type Package = { name: string; version: string; source?: string; checksum?: string };
export type Identity = { name: string; version: string; source: string | null; checksum: string | null; manifestPath: string | null };
export type ClosureEntry = Identity & { dependencies: Identity[]; features: string[] };
type CargoMetadata = {
  packages: { id: string; name: string; version: string; source: string | null; manifest_path: string }[];
  resolve: { nodes: { id: string; dependencies: string[]; features: string[] }[] };
};

function table(value: unknown, label: string): Table {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: missing TOML table`);
  return value as Table;
}

async function toml(path: string): Promise<Table> {
  return table(Bun.TOML.parse(await Bun.file(path).text()), path);
}

function patches(manifest: Table, path: string): Record<string, Record<string, string>> {
  const entries: Record<string, Record<string, string>> = {};
  for (const [registry, entriesValue] of Object.entries(table(manifest.patch, `${path} [patch]`))) {
    const targets: Record<string, string> = {};
    for (const [name, target] of Object.entries(table(entriesValue, `${path} [patch.${registry}]`))) {
      const spec = table(target, `${path} patch ${name}`);
      if (typeof spec.path !== "string") throw new Error(`${path}: patch ${name} must have a local path`);
      targets[name] = resolve(dirname(path), spec.path);
    }
    entries[registry] = targets;
  }
  return entries;
}

function same(label: string, paths: string[], left: unknown, right: unknown): void {
  // Table key order, lockfile package order and dependency ordering are not semantic.
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
    return value;
  };
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) {
    throw new Error(`${label} differs between ${paths[0]} and ${paths[1]}`);
  }
}

function identity(pkg: Package, resolved: CargoMetadata["packages"][number]): Identity {
  return {
    name: pkg.name, version: pkg.version, source: pkg.source ?? null, checksum: pkg.checksum ?? null,
    manifestPath: resolved.source === null ? relative(realpathSync(desktop), realpathSync(resolved.manifest_path)) : null,
  };
}

function metadata(manifest: string, runnerMetal = false): CargoMetadata {
  // Cargo.lock omits a source for dependencies such as "swift-rs 1.0.7",
  // even when path and registry packages share that name and version. Cargo's
  // resolved graph carries exact package IDs; never guess which source won.
  const command = ["cargo", "metadata", "--locked", "--format-version", "1", "--manifest-path", manifest];
  if (runnerMetal) command.push("--features", "transcript-quality-runner/metal");
  const result = Bun.spawnSync(command, {
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`cargo metadata for ${manifest} failed:\n${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as CargoMetadata;
}

export function closure(lock: Table, graph: CargoMetadata, path: string): ClosureEntry[] {
  if (!Array.isArray(lock.package)) throw new Error(`${path}: no [[package]] entries`);
  const locked = new Map<string, Package>();
  for (const pkg of lock.package as Package[]) {
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error(`${path}: malformed package entry`);
    const key = JSON.stringify([pkg.name, pkg.version, pkg.source ?? null]);
    if (locked.has(key)) throw new Error(`${path}: duplicate package identity ${key}`);
    locked.set(key, pkg);
  }
  const byId = new Map(graph.packages.map(pkg => [pkg.id, pkg]));
  const nodes = new Map(graph.resolve.nodes.map(node => [node.id, node]));
  const identities = new Map<string, Identity>();
  const resolvedIdentity = (pkg: Package, resolved: CargoMetadata["packages"][number]): Identity => {
    const cached = identities.get(resolved.id);
    if (cached) return cached;
    const value = identity(pkg, resolved);
    identities.set(resolved.id, value);
    return value;
  };
  const seen = new Set<string>();
  const pending = roots.map(name => {
    const matches = graph.packages.filter(pkg => pkg.name === name);
    if (matches.length !== 1) throw new Error(`${path}: expected one ${name} root, found ${matches.length}`);
    return matches[0].id;
  });
  const entries: ClosureEntry[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const pkg = byId.get(id);
    const node = nodes.get(id);
    if (!pkg || !node) throw new Error(`${path}: unresolved Cargo package ${id}`);
    const lockPkg = locked.get(JSON.stringify([pkg.name, pkg.version, pkg.source]));
    if (!lockPkg) throw new Error(`${path}: ${pkg.name} ${pkg.version} (${pkg.source}) absent from lockfile`);
    const dependencies = node.dependencies.map(childId => {
      const child = byId.get(childId);
      if (!child) throw new Error(`${path}: unresolved dependency ${childId} of ${pkg.name}`);
      const lockedChild = locked.get(JSON.stringify([child.name, child.version, child.source]));
      if (!lockedChild) throw new Error(`${path}: dependency ${childId} absent from lockfile`);
      pending.push(childId);
      return resolvedIdentity(lockedChild, child);
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    entries.push({ ...resolvedIdentity(lockPkg, pkg), dependencies, features: [...node.features].sort() });
  }
  return entries.sort((a, b) => JSON.stringify([a.name, a.version, a.source, a.checksum, a.manifestPath])
    .localeCompare(JSON.stringify([b.name, b.version, b.source, b.checksum, b.manifestPath])));
}

/** Compare shared code, not feature-only packages injected by the Tauri app.
 * Path packages use Cargo's resolved manifest path (including dependency edges);
 * name/version and lockfile source/checksum alone cannot distinguish path forks.
 * The only eval-only package is the upstream test-data crate. A same-named
 * package with a different version/source/checksum/path is never an exception.
 * Every shared eval feature must be enabled in the app. The six transcription
 * crates additionally match exactly: Linux permits only the listed app-only
 * accelerator features; macOS compares the Metal-enabled runner exactly.
 */
export function assertDependencyParity(evalClosure: ClosureEntry[], appClosure: ClosureEntry[], platform: Platform = "linux"): void {
  const appByName = new Map<string, ClosureEntry[]>();
  for (const pkg of appClosure) {
    const matches = appByName.get(pkg.name) ?? [];
    matches.push(pkg);
    appByName.set(pkg.name, matches);
  }
  for (const pkg of evalClosure) {
    const matches = appByName.get(pkg.name) ?? [];
    if (!matches.length && evalOnlyDevDependencies[pkg.name]) continue;
    const app = matches.find(candidate =>
      candidate.version === pkg.version && candidate.source === pkg.source &&
      candidate.checksum === pkg.checksum && candidate.manifestPath === pkg.manifestPath);
    if (!app)
      throw new Error(`dependency parity: ${pkg.name} ${pkg.version} (${pkg.source ?? "path"}, ${pkg.checksum ?? "no checksum"}, manifest ${pkg.manifestPath ?? "n/a"}) is absent from the app closure`);
    const missing = pkg.features.filter(feature => !app.features.includes(feature));
    if (missing.length)
      throw new Error(`feature parity (${platform}): ${pkg.name} eval-only=[${missing.join(", ")}] eval=[${pkg.features.join(", ")}] app=[${app.features.join(", ")}]`);
  }
  for (const name of featureParity) {
    const evalPackages = evalClosure.filter(pkg => pkg.name === name);
    const appPackages = appByName.get(name) ?? [];
    if (evalPackages.length !== 1 || appPackages.length !== 1)
      throw new Error(`feature parity: expected one ${name} in each closure`);
    const left = evalPackages[0].features;
    const right = appPackages[0].features;
    const allowed = platform === "linux" ? linuxAcceleratorFeatures[name] ?? [] : [];
    const common = right.filter(feature => !allowed.includes(feature));
    if (JSON.stringify(left) !== JSON.stringify(common))
      throw new Error(`feature parity (${platform}): ${name} eval=[${left.join(", ")}] app=[${right.join(", ")}]; allowed app-only=[${allowed.join(", ")}]`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const platform: Platform = args[0] === "--platform" ? args[1] as Platform : "linux";
  const outputArg = args[0] === "--platform" ? args[2] : args[0];
  if (!["linux", "macos"].includes(platform) || args.length > (args[0] === "--platform" ? 3 : 1))
    throw new Error("usage: check-workspace-sync.ts [--platform linux|macos] [output.json]");
  const [evalManifest, appManifest] = await Promise.all(manifests.map(toml));
  same("patch targets", manifests, patches(evalManifest, manifests[0]), patches(appManifest, manifests[1]));
  same("profiles", manifests, evalManifest.profile ?? {}, appManifest.profile ?? {});
  for (const [path, manifest] of manifests.map((path, i) => [path, [evalManifest, appManifest][i]] as const)) {
    const release = table(table(manifest.profile, `${path} [profile]`).release, `${path} [profile.release]`);
    if (table(release["build-override"], `${path} [profile.release.build-override]`).strip !== "none")
      throw new Error(`${path}: release build-override must keep strip = "none"`);
  }
  const [evalLock, appLock] = await Promise.all(locks.map(toml));
  const evalClosure = closure(evalLock, metadata(manifests[0], platform === "macos"), locks[0]);
  const appClosure = closure(appLock, metadata(manifests[1]), locks[1]);
  assertDependencyParity(evalClosure, appClosure, platform);
  const output = resolve(outputArg ?? resolve(import.meta.dir, "closure.json"));
  await Bun.write(output, JSON.stringify({ roots, platform, evalOnlyDevDependencies: Object.keys(evalOnlyDevDependencies), packages: evalClosure }, null, 2) + "\n");
  console.log(`Workspace manifests and ${evalClosure.length} eval closure packages agree with app (${platform}); wrote ${output}`);
}

if (import.meta.main) await main();
