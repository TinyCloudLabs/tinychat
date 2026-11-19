import { createServer } from "node:http";

/**
 * Stands in, on this machine, for the location registry a client consults when it signs in. Every owner is unknown
 * to it, which is what the real registry answers for a key made a moment ago. With no registry at all the client
 * refuses to sign in; with the real one, a test that is meant to stay on this machine does not.
 */
export async function emptyLocationRegistry(): Promise<{ url: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "location record not found" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, asked, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
