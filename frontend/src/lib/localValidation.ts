import type { TinyCloudWeb } from "@tinycloud/web-sdk";

/** Local real-data validation is opt-in and must never run on a deployed page. */
export function resolveLocalValidation(
  env: { VITE_LOCAL_VALIDATION?: string; VITE_BACKEND_URL?: string; DEV?: boolean },
  hostname?: string,
): boolean {
  const flag = env.VITE_LOCAL_VALIDATION;
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag !== "true") throw new Error("VITE_LOCAL_VALIDATION must be true or false");
  if (env.DEV !== true) throw new Error("Local validation requires Vite DEV");
  if (!hostname || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
    throw new Error("Local validation requires a loopback hostname");
  }
  if (env.VITE_BACKEND_URL) {
    let backend: URL;
    try { backend = new URL(env.VITE_BACKEND_URL); }
    catch { throw new Error("Local validation requires a loopback HTTP backend"); }
    if (!["http:", "https:"].includes(backend.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname)) {
      throw new Error("Local validation requires a loopback HTTP backend");
    }
  }
  return true;
}

export function localValidationEnabled(): boolean {
  return resolveLocalValidation(import.meta.env, globalThis.location?.hostname);
}

/**
 * Pinned web-sdk 2.5.1 has no public setting that disables all automatic account
 * writes. Patch ONLY this local instance before signIn; normal activation,
 * manifests, delegated reads and the production SDK remain unchanged.
 * The explicit shape check fails closed if an SDK update removes these hooks.
 */
export async function prepareLocalSignIn(tcw: TinyCloudWeb): Promise<void> {
  const web = tcw as unknown as { ensureNode?: () => Promise<Record<string, unknown>> };
  if (typeof web.ensureNode !== "function") throw new Error("SDK local validation hook unavailable: ensureNode");
  const node = await web.ensureNode();
  for (const hook of ["bootstrapAccountIfNeeded", "ensureRequestedEncryptionNetworks", "scheduleAccountRegistrySync", "ensureOwnedSpaceHostedById"]) {
    if (typeof node[hook] !== "function") throw new Error(`SDK local validation hook unavailable: ${hook}`);
  }
  node.bootstrapAccountIfNeeded = async () => false;
  node.ensureRequestedEncryptionNetworks = async () => {};
  node.scheduleAccountRegistrySync = () => {};
  node.ensureOwnedSpaceHostedById = async () => { throw new Error("Local validation cannot host a space"); };
}
