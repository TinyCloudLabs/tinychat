// Long-lived CDP controller for the Exo WebView (DevTools forwarded by launch-app.sh).
// One session for the whole run; prints console/exception lines to stdout. Commands are JSON files in
// $EXO_STATE/cmd ({"eval": "<js, may return a promise>"} or {"cdp": "<Method>", "params": {...}});
// results land in $EXO_STATE/out. Use cdp.sh rather than writing the files by hand.
import fs from "node:fs";

const state = process.env.EXO_STATE ?? "/tmp/exo-android-dev";
const port = process.env.EXO_DEVTOOLS_PORT ?? "9333";
fs.mkdirSync(`${state}/cmd`, { recursive: true });
fs.mkdirSync(`${state}/out`, { recursive: true });

const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    log(`[console.${msg.params.type}]`, msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 500));
  } else if (msg.method === "Runtime.exceptionThrown") {
    log("[exception]", (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 600));
  }
};
ws.onclose = () => { log("devtools connection closed"); process.exit(1); };
await new Promise((resolve) => { ws.onopen = resolve; });
await send("Runtime.enable");
log("ready", page.url);

setInterval(async () => {
  for (const file of fs.readdirSync(`${state}/cmd`).filter((f) => f.endsWith(".json")).sort()) {
    let body;
    try { body = JSON.parse(fs.readFileSync(`${state}/cmd/${file}`, "utf8")); } catch { continue; }
    fs.unlinkSync(`${state}/cmd/${file}`);
    let out;
    try {
      if (body.eval) {
        const r = await send("Runtime.evaluate", { expression: body.eval, awaitPromise: true, returnByValue: true, userGesture: true });
        out = r.exceptionDetails ? "EXC " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : JSON.stringify(r.result.value);
      } else {
        out = JSON.stringify(await send(body.cdp, body.params ?? {}));
      }
    } catch (error) {
      out = "ERROR " + String(error?.stack ?? error);
    }
    fs.writeFileSync(`${state}/out/${file.replace(/\.json$/, ".txt")}`, out ?? "");
  }
}, 250);
