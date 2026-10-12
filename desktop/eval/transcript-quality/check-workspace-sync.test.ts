import { expect, test } from "bun:test";
import { assertDependencyParity, type ClosureEntry } from "./check-workspace-sync";

const pkg = (name: string, version = "0.1.0"): ClosureEntry => ({
  name, version, source: null, checksum: null, dependencies: [], features: ["default"],
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
