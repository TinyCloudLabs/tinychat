import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ReplicationSettings, REPLICATION_COPY } from "./ReplicationSettings";
import { REPLICATION_COPY_KEY } from "./replicationCopyMarker";
import { REPLICATION_RUNTIME_FLAG_KEY } from "./replicationFlag";
import { replicationOptInKey } from "./replicationOptIn";
import { resetReplicationStatus } from "./replicationStatus";

const ALICE = "did:pkh:eip155:1:0xaaaa";
const BOB = "did:pkh:eip155:1:0xbbbb";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const GLOBAL_NAMES = ["window", "navigator", "indexedDB", "Worker"] as const;

let saved = new Map<string, PropertyDescriptor | undefined>();

function install(storage: Record<string, string>): void {
  const store = new Map(Object.entries(storage));
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: () => undefined, removeItem: () => undefined } });
  define("navigator", { userAgent: CHROME, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: () => undefined } });
  define("indexedDB", {});
  define("Worker", class {});
}

const render = (did: string) => renderToStaticMarkup(<ReplicationSettings tcw={{ did } as unknown as TinyCloudWeb} />);

beforeEach(() => {
  saved = new Map(GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  resetReplicationStatus();
});
afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  resetReplicationStatus();
});

describe("ReplicationSettings", () => {
  test("build flag OFF and no local copy: renders nothing", () => {
    install({});
    expect(render(ALICE)).toBe("");
  });

  test("build flag OFF but a copy may exist: only the wipe button and the status, no switch", () => {
    install({ [REPLICATION_COPY_KEY]: ALICE });
    const html = render(ALICE);
    expect(html).toContain(REPLICATION_COPY.wipeButton);
    expect(html).not.toContain('data-testid="replication-switch"');
    expect(html).toContain("Local copy: off");
  });

  test("build flag ON, new profile: the switch is offered, unchecked, with its help, and there is nothing to wipe", () => {
    install({ [REPLICATION_RUNTIME_FLAG_KEY]: "true" });
    const html = render(ALICE);
    expect(html).toContain(REPLICATION_COPY.switchLabel);
    expect(html).toContain(REPLICATION_COPY.switchHelp);
    expect(html).toMatch(/<input type="checkbox"[^>]*data-testid="replication-switch"/);
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(html).not.toContain(REPLICATION_COPY.wipeButton);
    expect(html).toContain("Local copy: off");
  });

  test("the switch shows each account's own choice", () => {
    install({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(ALICE)]: "true" });
    expect(render(ALICE)).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(render(ALICE)).toContain("Local copy: on · starts at your next sign-in");
    expect(render(BOB)).not.toMatch(/<input type="checkbox"[^>]*checked=""/);
  });

  test("an unsupported platform never offers the switch, whatever the stored choice", () => {
    install({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(ALICE)]: "true" });
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", locks: { request: () => undefined } } });
    expect(render(ALICE)).toBe("");
  });
});
