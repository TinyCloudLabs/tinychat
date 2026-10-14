import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { reportStorageError, reportStorageWriteSucceeded } from "@/lib/storageStatus";
import { installDom } from "@/test/dom";
import { CaptureSettings, SettingsPanel, type SettingsPanelProps } from "./CaptureSettings";

const IDLE = { pending: false, error: null };

const noInputs = {
  list: async () => ({ inputs: [], selectedId: null, activeId: null }),
  select: async () => {},
  subscribe: () => () => {},
};

const panelProps: SettingsPanelProps = {
  variant: "app",
  extrasAvailable: true,
  load: { status: "ready", data: { models: [], selected: null, systemAudio: false, uploadAudio: true } },
  downloads: {},
  microphone: {
    name: "MacBook Pro Microphone",
    inputs: [{ id: "MacBook Pro Microphone", name: "MacBook Pro Microphone" }],
    currentId: "MacBook Pro Microphone",
    selectedMissing: null,
    select: () => {},
    unavailable: false,
    error: null,
    retry: null,
  },
  modelError: null,
  switches: { systemAudio: IDLE, uploadAudio: IDLE },
  onRetryLoad: () => {},
  onSelectModel: () => {},
  onGetModel: () => {},
  onToggle: () => {},
};

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
  reportStorageWriteSucceeded();
});

describe("CaptureSettings while storage is full", () => {
  test("the gear shows a storage-full dot while storage is read-only, and clears once a write succeeds", async () => {
    const host = await mount(<CaptureSettings variant="microphone-only" inputs={noInputs} />);
    const dot = () => host.querySelector('[aria-label="Storage full"]');
    expect(dot()).toBeNull();
    await act(async () => reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED" }));
    expect(dot()).not.toBeNull();
    await act(async () => reportStorageWriteSucceeded());
    expect(dot()).toBeNull();
  });

  test("the upload switch keeps its setting and shows it is paused only while storage is read-only", async () => {
    const host = await mount(<SettingsPanel {...panelProps} />);
    const upload = () => host.querySelector('[data-testid="switch-upload-audio"]');
    const status = () => upload()?.closest(".cs-tgl")?.querySelector('[role="status"]') ?? null;
    expect(upload()?.getAttribute("aria-checked")).toBe("true");
    expect(status()).toBeNull();
    await act(async () => reportStorageError({ code: "STORAGE_QUOTA_EXCEEDED" }));
    expect(status()).not.toBeNull();
    expect(upload()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => reportStorageWriteSucceeded());
    expect(status()).toBeNull();
    expect(upload()?.getAttribute("aria-checked")).toBe("true");
  });
});
