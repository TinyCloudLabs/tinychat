// N6 QA runner. From frontend/, set TC_BOT_HISTORY_QA=1, TC_BOT_HISTORY_QA_OWNER,
// TC_BOT_HISTORY_QA_KEY, TC_BOT_HISTORY_QA_SIGNER_DID, VITE_TINYCLOUD_HOST,
// VITE_OPENKEY_HOST, and VITE_BACKEND_URL to the QA configuration. Run:
//   bunx vite --config scripts/bot-history-restored-session.qa.vite.ts --port 5186 --strictPort
// Use a 32-hex sibling key and the QA delegate's chain-1 DID, never Main.
// Web: sign in with the QA account once and reload the page.
// Phone: point the native QA shell at this server using EXO_DEV_SERVER_URL
// (see mobile/capacitor.config.ts), sign in once, then cold-launch it again.
// Allow at most one additional sign-in across both. Stop if approval is needed.
// Look for "[bot-history-qa]" and "issued without approval" for each platform.
// The probe mints against the configured node and discards the result. It does not
// submit the grant to a backend or create a history record.
import { defineConfig, mergeConfig, type Plugin } from "vite";
import appConfig from "../vite.config";

const probeId = "virtual:bot-history-restored-session-qa";

export default defineConfig(env => {
  if (env.command !== "serve" || process.env.TC_BOT_HISTORY_QA !== "1") {
    throw new Error("Start the restored-session QA runner with its explicit opt-in flag in a dev server.");
  }
  const address = process.env.TC_BOT_HISTORY_QA_OWNER?.toLowerCase();
  const key = process.env.TC_BOT_HISTORY_QA_KEY;
  const did = process.env.TC_BOT_HISTORY_QA_SIGNER_DID;
  if (!address || !/^0x[0-9a-f]{40}$/.test(address) || !key || !/^[0-9a-f]{32}$/.test(key)
    || !did || !/^did:pkh:eip155:1:0x[a-fA-F0-9]{40}$/.test(did)) throw new Error("Set the QA owner, sibling key and signer DID.");
  for (const name of ["VITE_OPENKEY_HOST", "VITE_TINYCLOUD_HOST", "VITE_BACKEND_URL"]) {
    const endpoint = process.env[name];
    const url = endpoint ? URL.parse(endpoint) : null;
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`Set ${name} to a QA endpoint.`);
    }
  }
  const plugin: Plugin = {
    name: "bot-history-restored-session-qa",
    enforce: "pre",
    resolveId(id) {
      if (id === probeId) return `\0${id}`;
    },
    load(id) {
      if (id !== `\0${probeId}`) return;
      return `
        import { mintSiblingHistoryGrant, BotHistoryApprovalNeeded } from "/src/bots/historyGrant.ts";
        let ran = false;
        export async function run(tcw, platform) {
          if (ran) return;
          ran = true;
          const report = result => console.info("[bot-history-qa]", platform, result);
          try {
            if (tcw.address()?.toLowerCase() !== ${JSON.stringify(address)}) return report("wrong QA account");
            const host = tcw.hosts[0];
            if (!host || new URL(host).origin !== new URL(import.meta.env.VITE_TINYCLOUD_HOST).origin) {
              return report("wrong QA node");
            }
            await mintSiblingHistoryGrant(tcw, ${JSON.stringify(did)}, ${JSON.stringify(address)}, ${JSON.stringify(key)});
            report("issued without approval");
          } catch (error) {
            report(error instanceof BotHistoryApprovalNeeded ? "approval needed" : "failed");
          }
        }
      `;
    },
    transform(code, id) {
      if (!id.endsWith("/src/App.tsx")) return;
      const restorePoints = [
        ['logSession("restore", "done");', "nativeTcw", "phone", "setTcw(nativeTcw);"],
        ['case "restored": {', "restoredTcw", "web", "setTcw(restoredTcw);"],
      ] as const;
      for (const [start, client, platform, marker] of restorePoints) {
        const at = code.indexOf(marker, code.indexOf(start));
        if (at === -1 || code.indexOf(marker) !== at) throw new Error(`QA restore point moved: ${platform}`);
        const end = at + marker.length;
        code = code.slice(0, end) + `\n          void runBotHistoryQa(${client}, "${platform}");` + code.slice(end);
      }
      return `import { run as runBotHistoryQa } from "${probeId}";\n${code}`;
    },
  };
  return mergeConfig(appConfig(env), { plugins: [plugin] });
});
