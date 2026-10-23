import { appPlatform } from "./platform";
import { isNativeOpenKeySignIn } from "./openkeyNative";
import { selectNewSessionHosts } from "./tinycloudHosts";

/** CI-only packaged webview probe. The transport is offline; no wallet or issuer is opened. */
export async function runTinyCloudHostSelftest(configuredHost: string) {
  const probes: Array<{ url: string; method: string; credentials: RequestCredentials; hasBody: boolean; hasAuthorization: boolean }> = [];
  const flow = isNativeOpenKeySignIn() ? "native" : "widget";
  const hosts = await selectNewSessionHosts(configuredHost, async (input, init) => {
    const request = new Request(input, init);
    probes.push({
      url: request.url, method: request.method, credentials: request.credentials,
      hasBody: request.body !== null, hasAuthorization: request.headers.has("authorization"),
    });
    return Response.json({ protocol: 1 });
  }, flow);
  return { marker: "EXO_IPC_SELFTEST_HOST_POLICY", platform: appPlatform(), flow, hosts, probes };
}
