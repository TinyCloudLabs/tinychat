import type { OnDeviceSttPlugin, OnDeviceSttStatus, SttModelId } from "./onDeviceStt";

type Listener = (value: never) => void;
const modelIds: SttModelId[] = ["parakeet-tdt-0.6b-v3-int8", "parakeet-tdt-110m-en-int8", "silero-vad", "diarization"];

export interface FakeOnDeviceStt {
  plugin: OnDeviceSttPlugin;
  controls: {
    setModel(id: SttModelId, state: OnDeviceSttStatus["models"][number]["state"], bytes?: number, totalBytes?: number): void;
    progress(id: string, percent: number): void;
    finish(id: string, outcome: "transcribed" | "no_speech"): void;
    fail(id: string, code: string, message: string): void;
    setAppleSpeech(state: OnDeviceSttStatus["appleSpeech"]): void;
  };
}

export function createFakeOnDeviceStt(pack: "full" | "small" = "full", isTombstoned: (id: string) => boolean = () => false): FakeOnDeviceStt {
  const status: OnDeviceSttStatus = {
    models: modelIds.map((id) => ({ id, state: "absent", bytes: 0, totalBytes: 0, error: null })),
    pack, autoDownload: true, download: { policy: "wifi", state: "idle" },
    engine: "none", appleSpeech: "unsupported", queue: [],
  };
  const listeners = new Map<string, Set<Listener>>();
  const retained = new Map<string, unknown>();
  const emit = (event: string, value: unknown) => {
    if (event === "status" || event === "transcribed" || event === "failed") retained.set(event, value);
    for (const listener of listeners.get(event) ?? []) (listener as (value: unknown) => void)(value);
  };
  const snapshot = (): OnDeviceSttStatus => structuredClone(status);
  const emitStatus = () => emit("status", snapshot());
  const mainModel = () => status.models.find((m) => m.id === (pack === "full" ? modelIds[0] : modelIds[1]));
  const refreshEngine = () => { status.engine = mainModel()?.state === "ready" ? "parakeet" : status.appleSpeech === "ready" ? "apple-speech" : "none"; };
  const queueEntry = (id: string) => {
    const item = status.queue.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("not_found"), { code: "not_found" });
    return item;
  };
  const checkTombstone = (id: string) => {
    if (isTombstoned(id)) throw Object.assign(new Error("tombstoned"), { code: "tombstoned" });
  };

  const plugin: OnDeviceSttPlugin = {
    async status() { return snapshot(); },
    async setAutoDownload({ enabled }) { status.autoDownload = enabled; emitStatus(); },
    async downloadNow({ allowCellular }) {
      status.download = { policy: allowCellular ? "cellular_approved" : "wifi", state: "running" };
      for (const model of status.models) if (model.state === "absent" || model.state === "failed") model.state = "queued";
      emitStatus();
    },
    async cancelDownload() { status.download.state = "idle"; for (const model of status.models) if (model.state === "queued" || model.state === "downloading") model.state = "absent"; emitStatus(); },
    async deleteModels() { for (const model of status.models) { model.state = "absent"; model.bytes = 0; } refreshEngine(); emitStatus(); },
    async enqueue({ id }) {
      checkTombstone(id);
      if (!status.queue.some((entry) => entry.id === id)) status.queue.push({ id, state: status.engine === "none" ? "waiting_for_model" : "queued", percent: null, error: null });
      emitStatus();
    },
    async cancel({ id }) { const item = queueEntry(id); item.state = "cancelled"; emitStatus(); },
    addListener(event: string, listener: Listener) {
      let set = listeners.get(event); if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
      if (retained.has(event)) queueMicrotask(() => { if (set?.has(listener)) (listener as (value: unknown) => void)(retained.get(event)); });
      return Promise.resolve({ remove: async () => { set?.delete(listener); } });
    },
  } as OnDeviceSttPlugin;

  return { plugin, controls: {
    setModel(id, state, bytes = 0, totalBytes = 0) {
      const model = status.models.find((entry) => entry.id === id);
      if (!model) throw new Error("Unknown model");
      Object.assign(model, { state, bytes, totalBytes, error: null });
      refreshEngine();
      if (status.engine !== "none") for (const item of status.queue) if (item.state === "waiting_for_model") item.state = "queued";
      emitStatus();
    },
    progress(id, percent) { checkTombstone(id); const item = queueEntry(id); item.state = "running"; item.percent = percent; emit("progress", { id, percent }); emitStatus(); },
    finish(id, outcome) { checkTombstone(id); const item = queueEntry(id); item.state = "done"; item.percent = 100; emit("transcribed", { id, outcome }); emitStatus(); },
    fail(id, code, message) { checkTombstone(id); const item = queueEntry(id); item.state = "failed"; item.error = code; emit("failed", { id, code, message }); emitStatus(); },
    setAppleSpeech(state) { status.appleSpeech = state; refreshEngine(); emitStatus(); },
  } };
}
