// The real network behind the page guard (fetch-guard.ts): name resolution and one socket to an address the guard has
// already checked. Kept apart so the guard's rules are tested against scripted servers, and this file against a real
// socket. TLS is verified (certificate chain and name) against the original host name, not the address dialled.

import { lookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { Conn, GuardDeps } from "./fetch-guard";

/** A connection that has not opened by now is dropped; the guard's own deadline then covers the read. */
export const CONNECT_MS = 10_000;

export function connectTo(ip: string, port: number, secure: boolean, servername: string, connectMs = CONNECT_MS): Promise<Conn> {
  const opened = Promise.withResolvers<Conn>();
  const socket = secure
    ? tls.connect({ host: ip, port, servername, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] })
    : net.connect({ host: ip, port });
  socket.setNoDelay(true);
  socket.setTimeout(connectMs);
  // A later error (reset, timeout) ends the read; it is not an uncaught exception.
  socket.on("error", error => opened.reject(error));
  socket.once("timeout", () => socket.destroy(new Error("connect timeout")));
  socket.once(secure ? "secureConnect" : "connect", () => {
    socket.setTimeout(0);
    opened.resolve({
      write: data => void socket.write(data),
      read: () => socket,
      destroy: () => void socket.destroy(),
    });
  });
  return opened.promise;
}

export const networkDeps: GuardDeps = {
  // Every answer, in both families, exactly as the resolver gave them: the guard judges all of them.
  lookup: async host => (await lookup(host, { all: true, verbatim: true })).map(answer => answer.address),
  connect: (ip, port, secure, servername) => connectTo(ip, port, secure, servername),
};
