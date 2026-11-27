// One Apps dev harness: open /one-apps-dev.html?node=<local node URL> on the `bun run dev:apps` server.
// One's sign-in needs an OpenKey passkey, so this page signs a throwaway key into a local node (shared/local-run-kit)
// and mounts One's real shell (AppShell, nav, launcher, framed routes, as App.tsx wires them) with the real
// FramedAppScreen: the same frame, EmbedHost, grants, ask card and step-up One uses; only the wallet is a local key
// (OpenKey's role in the step-up included). The key lives in memory for this page load only.
import "../../index.css";
import type { Manifest, TinyCloudWeb } from "@tinycloud/web-sdk";
import { createAndSignIn } from "@tinyboilerplate/client";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { installEd25519Polyfill } from "../../lib/ed25519Polyfill";
import { initSizeClass } from "../../lib/sizeClass";
import { initTheme } from "../../lib/theme";
import { AddAppPage } from "../AddAppPage";
import { FramedAppScreen, OneAppScreen } from "../FramedAppScreen";
import { AppsPage } from "../../home/AppsPage";
import { AppShell } from "../../shell/AppShell";
import { PATHS, screenFor } from "../../shell/routes";
import { ONE_NAV_ENABLED } from "../../shell/navPins";
import type { StepUpConnect } from "../stepUp";

if (!import.meta.env.DEV || import.meta.env.VITE_ONE_APPS !== "true") throw new Error("Run the One Apps dev harness with `bun run dev:apps`.");

const params = new URLSearchParams(window.location.search);
const node = params.get("node");
// A registry that knows no one (shared/local-run-kit registry-stub.ts) routes every owner to `node`: never the
// production registry.
const registry = params.get("registry");
// `?spaces=applications,account,credentials,secrets,public`: spaces to host and create for the throwaway key right after sign-in
// (the sign-in creates only the default ones), so an app whose space exists gets a real grant. Default none: the missing-space path.
const spaces = (params.get("spaces") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
// `?path=/chat/apps/add`: the route the shell opens on. `?bare`: the harness's own header only for screen readers (screenshots).
const startPath = params.get("path") ?? PATHS.apps;
const bare = params.has("bare");
const account = privateKeyToAccount(generatePrivateKey());

/** A minimal EIP-1193 wallet over the throwaway key: accounts, chain 1 and personal_sign. */
const provider = {
  async request({ method, params: args }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return "0x1";
      case "net_version":
        return "1";
      case "personal_sign":
        return account.signMessage({ message: { raw: (args?.[0] as Hex) } });
      default:
        throw new Error(`dev harness wallet: ${method} is not supported`);
    }
  },
  on() {},
  removeListener() {},
};

/** OpenKey's part in the step-up, played by the same key: the owner's address and a byte-exact signer. */
const connect: StepUpConnect = async () => ({
  address: account.address,
  openkey: { signMessage: async ({ message }) => ({ signature: await account.signMessage({ message }) }) },
});

// `?holds=apps-metadata`: the session also holds metadata reads on the owner's Apps space, as One's real sign-in does
// (it holds all of Apps), so the launcher's check for apps listed only for some accounts (listedApps.ts) can see them.
// Without it the session holds nothing, and every app's first open asks.
const HOLDS_APPS_METADATA = params.get("holds") === "apps-metadata";
const MANIFEST = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.one-apps-dev",
  name: "One Apps dev harness",
  defaults: true,
  permissions: HOLDS_APPS_METADATA ? [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["metadata"], skipPrefix: true }] : [],
} as unknown as Manifest;

const ACCOUNT_DID = `did:pkh:eip155:1:${account.address}`;

/** One's shell around the apps as App.tsx wires it: the nav, the launcher, the app screens and Add an app. Chat, Recording, Connectors and Settings are stand-ins. */
function HarnessShell({ tcw }: { tcw: TinyCloudWeb | null }) {
  const { pathname } = useLocation();
  const screen = useMemo(() => screenFor(pathname), [pathname]);
  const launcher = <AppsPage accountDid={ACCOUNT_DID} pendingMeetings={0} tcw={tcw} />;
  const notHere = <p className="p-4 text-sm text-muted-foreground">Not part of this harness.</p>;
  return (
    <AppShell
      screen={screen}
      accountDid={ACCOUNT_DID}
      platform="web"
      pendingMeetings={0}
      chat={notHere}
      capture={notHere}
      connectors={notHere}
      settings={ONE_NAV_ENABLED ? notHere : null}
      feed={notHere}
      apps={ONE_NAV_ENABLED
        ? screen.id === "addApp" ? <AddAppPage /> : screen.appId ? <OneAppScreen appId={screen.appId} tcw={tcw} accountDid={ACCOUNT_DID} connect={connect} fallback={launcher} /> : launcher
        : screen.appId ? <FramedAppScreen appId={screen.appId} tcw={tcw} connect={connect} fallback={launcher} /> : launcher}
    />
  );
}

function Harness() {
  const [tcw, setTcw] = useState<TinyCloudWeb | null>(null);
  const [status, setStatus] = useState(node && registry
    ? "Signed out"
    : "Add ?node=http://127.0.0.1:<port>&registry=http://127.0.0.1:<port> (local-run-kit start-node.sh and registry-stub.ts).");

  async function signIn() {
    if (!node || !registry) return;
    setStatus("Signing in…");
    try {
      const { tcw: signed } = await createAndSignIn(provider as never, {
        tinycloudHosts: [node],
        tinycloudRegistryUrl: registry,
        newUserHost: node,
        manifest: MANIFEST,
      } as never);
      for (const name of spaces) {
        setStatus(`Hosting ${name}…`);
        await signed.ensureOwnedSpaceHosted(name);
      }
      setTcw(signed);
      setStatus(`Signed in as ${account.address} on ${node}`);
    } catch (error) {
      setStatus(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className={bare ? "sr-only" : "flex flex-wrap items-center gap-2 border-b border-border p-2 text-sm"}>
        <strong>One Apps dev harness</strong>
        <button type="button" className="rounded border border-border px-2 py-1" onClick={() => void signIn()} disabled={!node || !!tcw}>Sign in (throwaway key)</button>
        <span data-testid="harness-status" className="text-muted-foreground">{status}</span>
      </header>
      <main className="min-h-0 flex-1">
        <MemoryRouter initialEntries={[startPath]}>
          <HarnessShell tcw={tcw} />
        </MemoryRouter>
      </main>
    </div>
  );
}

// The size class as One measures it, so the harness shows the pill, rail or sidebar the window gets.
initSizeClass();
initTheme();
void installEd25519Polyfill().finally(() => {
  createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
});
