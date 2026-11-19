// One Apps dev harness: https://localhost:5190/one-apps-dev.html?node=http://127.0.0.1:<port> under `bun run dev:apps`.
// One's sign-in needs an OpenKey passkey, so this page signs a throwaway key into a local node (shared/local-run-kit)
// and mounts the real FramedAppScreen: the same frame, EmbedHost, grants, ask card and step-up One uses; only the
// wallet is a local key (OpenKey's role in the step-up included). The key lives in memory for this page load only.
import "../../index.css";
import type { Manifest, TinyCloudWeb } from "@tinycloud/web-sdk";
import { createAndSignIn } from "@tinyboilerplate/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { installEd25519Polyfill } from "../../lib/ed25519Polyfill";
import { initTheme } from "../../lib/theme";
import { FramedAppScreen } from "../FramedAppScreen";
import { ONE_APPS } from "../registry";
import type { StepUpConnect } from "../stepUp";

if (!import.meta.env.DEV || import.meta.env.VITE_ONE_APPS !== "true") throw new Error("Run the One Apps dev harness with `bun run dev:apps`.");

const params = new URLSearchParams(window.location.search);
const node = params.get("node");
// A registry that knows no one (shared/local-run-kit registry-stub.ts) routes every owner to `node`: never the
// production registry.
const registry = params.get("registry");
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

const MANIFEST = { manifest_version: 1, app_id: "xyz.tinycloud.one-apps-dev", name: "One Apps dev harness", defaults: true, permissions: [] } as unknown as Manifest;

function Harness() {
  const [tcw, setTcw] = useState<TinyCloudWeb | null>(null);
  const [status, setStatus] = useState(node && registry
    ? "Signed out"
    : "Add ?node=http://127.0.0.1:<port>&registry=http://127.0.0.1:<port> (local-run-kit start-node.sh and registry-stub.ts).");
  const [appId, setAppId] = useState<string>(ONE_APPS.find((app) => app.kind === "framed" && app.framed)?.id ?? "");

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
      setTcw(signed);
      setStatus(`Signed in as ${account.address} on ${node}`);
    } catch (error) {
      setStatus(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-sm">
        <strong>One Apps dev harness</strong>
        <button type="button" className="rounded border border-border px-2 py-1" onClick={() => void signIn()} disabled={!node || !!tcw}>Sign in (throwaway key)</button>
        {ONE_APPS.filter((app) => app.kind === "framed").map((app) => (
          <button key={app.id} type="button" className={`rounded border px-2 py-1 ${app.id === appId ? "border-foreground" : "border-border"}`} onClick={() => setAppId(app.id)}>
            {app.name}
          </button>
        ))}
        <span data-testid="harness-status" className="text-muted-foreground">{status}</span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <FramedAppScreen appId={appId} tcw={tcw} connect={connect} fallback={<p className="p-4 text-sm">Not framed here (signed out, unknown app, or an app that opens in a new tab).</p>} />
      </main>
    </div>
  );
}

initTheme();
void installEd25519Polyfill().finally(() => {
  createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
});
