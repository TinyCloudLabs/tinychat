import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const streams = new Map<number, ReturnType<typeof sha256.create>>();
const expiry = new Map<number, ReturnType<typeof setTimeout>>();
function touch(stream: number) {
  clearTimeout(expiry.get(stream));
  expiry.set(stream, setTimeout(() => { streams.delete(stream); expiry.delete(stream); }, 30 * 60 * 1000));
}
type Request = { request: number; stream: number; op: "start" | "update" | "finish" | "digest"; bytes?: Uint8Array };
self.onmessage = (event: MessageEvent<Request>) => {
  const { request, stream, op, bytes } = event.data;
  try {
    let hash: string | undefined;
    if (op === "start") { streams.set(stream, sha256.create()); touch(stream); }
    if (op === "update") { streams.get(stream)!.update(bytes!); touch(stream); }
    if (op === "finish") {
      hash = bytesToHex(streams.get(stream)!.digest());
      streams.delete(stream);
      clearTimeout(expiry.get(stream)); expiry.delete(stream);
    }
    if (op === "digest") hash = bytesToHex(sha256(bytes!));
    self.postMessage({ request, hash });
  } catch (error) {
    streams.delete(stream);
    clearTimeout(expiry.get(stream)); expiry.delete(stream);
    self.postMessage({ request, error: error instanceof Error ? error.message : String(error) });
  }
};
