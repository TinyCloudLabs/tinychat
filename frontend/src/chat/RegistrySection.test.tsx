import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { signLocationRecordV2, type LocationRecordV2, type LocationRecordV2Payload } from "@tinycloud/sdk-core";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import {
  type RegistryChangeHistoryEntry,
  type RegistryChangeOutcome,
  type RegistryChangeRequest,
  type RegistryEditorAdapter,
  type RegistryUndoRequest,
} from "@/lib/registryEditor/adapter";
import { REGISTRY_EDITOR_COPY } from "@/lib/registryEditor/copy";
import { installDom } from "@/test/dom";
import { AgentAccessProvider } from "./useAgentEnablement";
import type { RegistrySection as RegistrySectionType } from "./RegistrySection";

// Radix portals do not reliably attach across test orderings in happy-dom: use an inline stand-in
// matching RegistryConsentDialog.test.tsx and restore the real module in afterAll.
const actualAlert = { ...(await import("../components/ui/alert-dialog")) };
type Kids = { children?: ReactNode };

const TEST_ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OWNER_DID = `did:pkh:eip155:1:${TEST_ACCOUNT.address}`;
const NODE_A_DID = "did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi";
const NODE_B_DID = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const NODE_C_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SPACE_DEFAULT = `tinycloud:pkh:eip155:1:${TEST_ACCOUNT.address.toLowerCase()}:default`;
const SPACE_FEED = `tinycloud:pkh:eip155:1:${TEST_ACCOUNT.address.toLowerCase()}:feed`;

async function makeRecord(overrides: Partial<LocationRecordV2Payload> = {}): Promise<LocationRecordV2> {
  const payload: LocationRecordV2Payload = {
    version: 2,
    subject: OWNER_DID,
    nodes: [
      { did: NODE_A_DID, url: "https://node.tinycloud.xyz" },
      { did: NODE_B_DID, url: "https://keys.example.com:8443" },
    ],
    spaces: [
      { space: SPACE_DEFAULT, nodes: [{ did: NODE_A_DID, mode: "read-write" }] },
      { space: SPACE_FEED, nodes: [{ did: NODE_A_DID, mode: "read-only" }] },
    ],
    encryptionNode: NODE_B_DID,
    updated_at: "2026-11-22T15:30:00.000Z",
    sequence: 4,
    ...overrides,
  };
  return signLocationRecordV2(payload, {
    type: "did:pkh",
    signMessage: (message) => TEST_ACCOUNT.signMessage({ message }),
  });
}

let cleanDom: (() => void) | undefined;
let createRootFn: typeof import("react-dom/client").createRoot;
let RegistrySection: typeof RegistrySectionType;
let root: Root | undefined;
let host: HTMLElement;

beforeAll(async () => {
  cleanDom = installDom();
  mock.module("../components/ui/alert-dialog", () => ({
    ...actualAlert,
    AlertDialog: (props: { open: boolean; onOpenChange?: (open: boolean) => void } & Kids) =>
      props.open ? <div role="alertdialog">{props.children}</div> : null,
    AlertDialogContent: (props: Kids) => <div>{props.children}</div>,
    AlertDialogHeader: (props: Kids) => <div>{props.children}</div>,
    AlertDialogTitle: (props: Kids) => <h2>{props.children}</h2>,
    AlertDialogDescription: (props: Kids) => <p>{props.children}</p>,
    AlertDialogFooter: (props: Kids) => <div>{props.children}</div>,
    AlertDialogCancel: (props: { onClick?: () => void; disabled?: boolean } & Kids) => (
      <button type="button" disabled={props.disabled} onClick={props.onClick}>{props.children}</button>
    ),
    AlertDialogAction: (props: { onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void; disabled?: boolean } & Kids) => (
      <button type="button" disabled={props.disabled} onClick={props.onClick}>{props.children}</button>
    ),
  }));
  ({ createRoot: createRootFn } = await import("react-dom/client"));
  ({ RegistrySection } = await import("./RegistrySection"));
});
afterAll(() => {
  mock.module("../components/ui/alert-dialog", () => actualAlert);
  cleanDom?.();
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

describe("Settings -> Where your data lives (RegistrySection)", () => {
  test("renders current v2 record including spaces, read-only note, distinct encryption line, hosts, and version", async () => {
    const record = await makeRecord();
    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => ({ status: "found", record }),
      fetchHistory: async () => ({ status: "ok", history: [] }),
      requestChange: async () => ({ status: "cancelled" }),
      requestUndo: async () => ({ status: "cancelled" }),
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    // Literal strings pinned against Monica's approved copy.
    expect(host.querySelector("h2")?.textContent).toBe("Where your data lives");
    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.intro);

    const spaceRows = [...host.querySelectorAll('[data-testid="registry-space-row"]')];
    expect(spaceRows).toHaveLength(2);
    expect(spaceRows[0]?.textContent).toContain("Default");
    expect(spaceRows[0]?.textContent).toContain("node.tinycloud.xyz");
    expect(spaceRows[1]?.textContent).toContain("Feed");
    expect(spaceRows[1]?.textContent).toContain("You can see this here, but not change it.");

    const encryptionRow = host.querySelector('[data-testid="registry-encryption-row"]');
    expect(encryptionRow?.textContent).toContain("Secrets and keys");
    expect(encryptionRow?.textContent).toContain("keys.example.com:8443");

    expect(host.querySelector('[data-testid="registry-nodes"]')?.textContent).toContain("Hosts:");
    expect(host.querySelector('[data-testid="registry-nodes"]')?.textContent).toContain("node.tinycloud.xyz");
    expect(host.querySelector('[data-testid="registry-nodes"]')?.textContent).toContain("keys.example.com:8443");
    expect(host.querySelector('[data-testid="registry-sequence"]')?.textContent).toBe("Version 4");
  });

  test("change calls the adapter with canonical input, drops stale DIDs on changed hosts, and preserves all record.nodes including unreferenced ones", async () => {
    const record = await makeRecord({
      nodes: [
        { did: NODE_A_DID, url: "https://node.tinycloud.xyz" },
        { did: NODE_B_DID, url: "https://keys.example.com:8443" },
        { did: NODE_C_DID, url: "https://standby.example.com" },
      ],
    });
    const submitted: RegistryChangeRequest[] = [];
    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => ({ status: "found", record }),
      fetchHistory: async () => ({ status: "ok", history: [] }),
      requestChange: async (req): Promise<RegistryChangeOutcome> => {
        submitted.push(req);
        return { status: "published", sequence: 5, recordHash: "0xhash5" };
      },
      requestUndo: async () => ({ status: "cancelled" }),
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    await act(async () => {
      buttonByText(host, REGISTRY_EDITOR_COPY.changeButton)!.click();
    });

    const defaultSpaceInput = host.querySelector<HTMLInputElement>(`input[id="registry-space-${SPACE_DEFAULT}"]`)!;
    const encryptionInput = host.querySelector<HTMLInputElement>('input[id="registry-encryption-node"]')!;

    await act(async () => {
      // Non-canonical: uppercase, default :443 port, trailing slash, surrounding spaces
      setInputValue(defaultSpaceInput, "  HTTPS://NEW-NODE.EXAMPLE.COM:443/  ");
      setInputValue(encryptionInput, "https://KEYS.example.com:8443/");
    });

    const form = host.querySelector<HTMLFormElement>('[data-testid="registry-editor-form"]')!;
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(submitted).toEqual([
      {
        nodes: [
          { url: "https://new-node.example.com" },
          { url: "https://node.tinycloud.xyz", did: NODE_A_DID },
          { url: "https://keys.example.com:8443", did: NODE_B_DID },
          { url: "https://standby.example.com", did: NODE_C_DID },
        ],
        spaces: [
          { space: SPACE_DEFAULT, nodes: [{ url: "https://new-node.example.com", mode: "read-write" }] },
          { space: SPACE_FEED, nodes: [{ url: "https://node.tinycloud.xyz", mode: "read-only" }] },
        ],
        encryptionNode: "https://keys.example.com:8443",
      },
    ]);
    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.changeSuccess);
  });

  test("invalid node URL shows inline validation error without calling adapter", async () => {
    const record = await makeRecord();
    let calls = 0;
    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => ({ status: "found", record }),
      fetchHistory: async () => ({ status: "ok", history: [] }),
      requestChange: async () => {
        calls += 1;
        return { status: "cancelled" };
      },
      requestUndo: async () => ({ status: "cancelled" }),
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    await act(async () => {
      buttonByText(host, REGISTRY_EDITOR_COPY.changeButton)!.click();
    });

    const defaultSpaceInput = host.querySelector<HTMLInputElement>(`input[id="registry-space-${SPACE_DEFAULT}"]`)!;
    await act(async () => {
      setInputValue(defaultSpaceInput, "not-a-url");
    });

    const form = host.querySelector<HTMLFormElement>('[data-testid="registry-editor-form"]')!;
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(calls).toBe(0);
    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.invalidNodeUrl);
  });

  test("requestChange rejection shows error message; cancelled outcome keeps editor open with no error or success notice", async () => {
    const record = await makeRecord();
    let nextResult: "cancel" | "throw" = "cancel";
    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => ({ status: "found", record }),
      fetchHistory: async () => ({ status: "ok", history: [] }),
      requestChange: async () => {
        if (nextResult === "throw") throw new Error("network failed");
        return { status: "cancelled" };
      },
      requestUndo: async () => ({ status: "cancelled" }),
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    await act(async () => {
      buttonByText(host, REGISTRY_EDITOR_COPY.changeButton)!.click();
    });

    const form = host.querySelector<HTMLFormElement>('[data-testid="registry-editor-form"]')!;
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(host.querySelector('[data-testid="registry-editor-form"]')).not.toBeNull();
    expect(host.textContent).not.toContain(REGISTRY_EDITOR_COPY.changeSuccess);
    expect(host.textContent).not.toContain(REGISTRY_EDITOR_COPY.changeFailure);

    nextResult = "throw";
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.changeFailure);
  });

  test("latest row shows Undo and Last changed when sequence matches; older rows show Restore; both call requestUndo with historyId", async () => {
    const current = await makeRecord({ sequence: 4 });
    const previousLatest = await makeRecord({ sequence: 3 });
    const olderRecord = await makeRecord({ sequence: 2, encryptionNode: null });

    const history: RegistryChangeHistoryEntry[] = [
      {
        id: "chg_latest",
        requestingOrigin: "https://external.app",
        previousRecord: previousLatest,
        newRecordHash: "0xhash4",
        newSequence: 4,
        createdAt: "2026-11-22T15:30:00.000Z",
      },
      {
        id: "chg_older",
        requestingOrigin: "https://tinycloud.one",
        previousRecord: olderRecord,
        newRecordHash: "0xhash3",
        newSequence: 3,
        createdAt: "2026-11-21T10:00:00.000Z",
      },
    ];

    const undoCalls: RegistryUndoRequest[] = [];
    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => ({ status: "found", record: current }),
      fetchHistory: async () => ({ status: "ok", history }),
      requestChange: async () => ({ status: "cancelled" }),
      requestUndo: async (req) => {
        undoCalls.push(req);
        return { status: "published", sequence: 5, recordHash: "0xhash5" };
      },
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    expect(host.querySelector('[data-testid="registry-last-changed"]')?.textContent).toContain("https://external.app");

    const rows = [...host.querySelectorAll('[data-testid="registry-history-row"]')];
    expect(rows).toHaveLength(2);
    expect(buttonByText(rows[0]!, REGISTRY_EDITOR_COPY.undoButton)).toBeDefined();
    expect(buttonByText(rows[0]!, REGISTRY_EDITOR_COPY.restoreButton)).toBeUndefined();
    expect(buttonByText(rows[1]!, REGISTRY_EDITOR_COPY.undoButton)).toBeUndefined();
    expect(buttonByText(rows[1]!, REGISTRY_EDITOR_COPY.restoreButton)).toBeDefined();

    // 1. Undo on latest row sends { historyId: "chg_latest" } and shows undoSuccess.
    await act(async () => {
      buttonByText(rows[0]!, REGISTRY_EDITOR_COPY.undoButton)!.click();
    });
    await flush();
    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.undoConfirmTitle);
    expect(host.textContent).toContain("Data saved at the new hosts in the meantime stays there.");
    await act(async () => {
      buttonByText(host, "Continue in OpenKey")!.click();
    });
    await flush();
    expect(host.textContent).toContain("Undone. Your apps use your previous hosts from their next sign-in.");

    // 2. Restore on older row sends { historyId: "chg_older" } and shows restoreSuccess.
    const refreshedRows = [...host.querySelectorAll('[data-testid="registry-history-row"]')];
    await act(async () => {
      buttonByText(refreshedRows[1]!, REGISTRY_EDITOR_COPY.restoreButton)!.click();
    });
    await flush();
    expect(host.textContent).toContain("Restore the version from before");
    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.restoreConfirmBody);
    await act(async () => {
      buttonByText(host, REGISTRY_EDITOR_COPY.restoreConfirmApprove)!.click();
    });
    await flush();

    expect(undoCalls).toEqual([{ historyId: "chg_latest" }, { historyId: "chg_older" }]);
    expect(host.textContent).toContain("Restored. Your apps use the hosts you had before");
    expect(host.textContent).toContain("from their next sign-in.");
    expect(host.textContent).not.toContain(REGISTRY_EDITOR_COPY.undoSuccess);
  });

  test("mismatched sequence hides Undo and Last changed while still offering Restore on history rows", async () => {
    const current = await makeRecord({ sequence: 7 });
    const staleLatest = await makeRecord({ sequence: 3 });

    const history: RegistryChangeHistoryEntry[] = [
      {
        id: "chg_stale",
        requestingOrigin: "https://external.app",
        previousRecord: staleLatest,
        newRecordHash: "0xhash4",
        newSequence: 4, // Does not match current.sequence (7)
        createdAt: "2026-11-22T15:30:00.000Z",
      },
    ];

    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => ({ status: "found", record: current }),
      fetchHistory: async () => ({ status: "ok", history }),
      requestChange: async () => ({ status: "cancelled" }),
      requestUndo: async () => ({ status: "cancelled" }),
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    expect(host.querySelector('[data-testid="registry-last-changed"]')).toBeNull();
    const row = host.querySelector('[data-testid="registry-history-row"]')!;
    expect(buttonByText(row, REGISTRY_EDITOR_COPY.undoButton)).toBeUndefined();
    expect(buttonByText(row, REGISTRY_EDITOR_COPY.restoreButton)).toBeDefined();
  });

  test("absent OpenKey methods keep the editor read-only: no edit/undo/restore controls, plus the read-only line", async () => {
    const record = await makeRecord({
      spaces: [{ space: SPACE_DEFAULT, nodes: [{ did: NODE_A_DID, mode: "read-write" }] }],
    });
    let historyFetched = 0;
    const adapter: RegistryEditorAdapter = {
      canEdit: false,
      canUndo: false,
      readCurrentRecord: async () => ({ status: "found", record }),
      fetchHistory: async () => {
        historyFetched += 1;
        return { status: "ok", history: [] };
      },
      requestChange: async () => {
        throw new Error("should not be called");
      },
      requestUndo: async () => {
        throw new Error("should not be called");
      },
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    expect(host.querySelector('[data-testid="registry-record"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="registry-encryption-row"]')?.textContent).toContain("keys.example.com:8443");
    expect(host.querySelector('[data-testid="registry-read-only-note"]')?.textContent).toBe(
      "You can see this here, but not change it.",
    );
    expect(buttonByText(host, REGISTRY_EDITOR_COPY.changeButton)).toBeUndefined();
    expect(buttonByText(host, REGISTRY_EDITOR_COPY.undoButton)).toBeUndefined();
    expect(buttonByText(host, REGISTRY_EDITOR_COPY.restoreButton)).toBeUndefined();
    expect(host.querySelector('[data-testid="registry-editor-form"]')).toBeNull();
    expect(host.querySelector('[data-testid="registry-history"]')).toBeNull();
    expect(historyFetched).toBe(0);
  });

  test("registry unreachable shows an error with retry button and does not crash", async () => {
    const record = await makeRecord();
    let attempts = 0;
    const adapter: RegistryEditorAdapter = {
      canEdit: true,
      canUndo: true,
      readCurrentRecord: async () => {
        attempts += 1;
        if (attempts === 1) return { status: "error", reason: "unreachable" };
        return { status: "found", record };
      },
      fetchHistory: async () => ({ status: "error", reason: "unreachable" }),
      requestChange: async () => ({ status: "cancelled" }),
      requestUndo: async () => ({ status: "cancelled" }),
    };

    root = createRootFn(host);
    await act(async () => {
      root!.render(<RegistrySection did={OWNER_DID} adapter={adapter} />);
    });
    await flush();

    expect(host.querySelector('[data-testid="registry-error"]')?.textContent).toContain(
      REGISTRY_EDITOR_COPY.registryUnreachable,
    );
    const retry = buttonByText(host, REGISTRY_EDITOR_COPY.retryButton)!;
    expect(retry).toBeDefined();

    await act(async () => {
      retry.click();
    });
    await flush();

    expect(attempts).toBe(2);
    expect(host.querySelector('[data-testid="registry-record"]')).not.toBeNull();
    expect(host.textContent).toContain(REGISTRY_EDITOR_COPY.historyUnavailable);
  });

  test("SettingsPage mounts the Where your data lives section with id=registry", async () => {
    const { SettingsPage } = await import("./SettingsPage");
    const tcw = {
      did: "did:example:account",
      spaceId: "space-1",
      address: () => "0x00000000000000000000000000000000000000a1",
    } as unknown as TinyCloudWeb;
    const sessionStore = { getToken: () => "signed-in-token" } as unknown as SessionStore;
    const noop = () => {};
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(
      <MemoryRouter>
        <PlatformContext.Provider value="web">
          <StaticRecorderProvider value={{ signedIn: true, available: false }}>
            <AgentAccessProvider backendUrl="http://localhost" sessionStore={sessionStore} tcw={tcw} appName="TinyCloud One" openkeyHost="http://localhost">
              <SettingsPage
                address={tcw.address()} did={tcw.did} spaceId={tcw.spaceId} state="ready" error={null}
                onSignOut={noop} signingOut={false} paywallEnabled={false} onBack={noop}
                tcw={tcw} memoryRef={createRef<string | null>()} onMemoryUpdated={noop} onImported={noop}
                billingStatus={null} billingTierName={null} onManagePlan={noop} onOpenRates={noop}
                backendUrl="http://localhost" sessionStore={sessionStore}
              />
            </AgentAccessProvider>
          </StaticRecorderProvider>
        </PlatformContext.Provider>
      </MemoryRouter>,
    );

    const section = page.querySelector("section#registry");
    expect(section).not.toBeNull();
    expect(section?.querySelector("h2")?.textContent).toBe("Where your data lives");
  });
});
