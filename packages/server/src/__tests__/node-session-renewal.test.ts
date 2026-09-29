import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

const sdkDist = dirname(require.resolve("@tinycloud/node-sdk"));

describe("installed node SDK session renewal", () => {
  for (const entry of ["index.js", "core.js"]) {
    test(`${entry} renews and retries with fresh keys for the same wallet`, () => {
      // The server suite preloads a node-sdk mock. A separate process exercises the
      // installed dependency with real WASM keys/signatures and no environment files.
      const probe = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--eval",
          `
          import assert from "node:assert/strict";
          const { NodeUserAuthorization } = await import(${JSON.stringify(join(sdkDist, entry))});
          const { NodeWasmBindings, PrivateKeySigner } = await import(${JSON.stringify(join(sdkDist, "index.js"))});
          const signer = new PrivateKeySigner("11".repeat(32)); // Synthetic, never used on a node.
          const address = (await signer.getAddress()).toLowerCase();
          Date.now = () => 1_800_000_000_000; // Exercise renewals in the same millisecond.

          globalThis.fetch = async (input) => {
            const url = String(input);
            if (url === "https://offline.invalid/info") {
              return Response.json({ protocol: new NodeWasmBindings().protocolVersion(), features: [] });
            }
            if (url === "https://offline.invalid/delegate") {
              return Response.json({ activated: [], skipped: [] });
            }
            throw new Error("Unexpected network request in offline session test");
          };

          async function exercise(failFirstPreparation) {
            const bindings = new NodeWasmBindings();
            const manager = bindings.createSessionManager();
            bindings.createSessionManager = () => manager;
            const prepareSession = bindings.prepareSession;
            let preparedCount = 0;
            bindings.prepareSession = (input) => {
              assert.equal(input.address.toLowerCase(), address);
              const prepared = prepareSession(input);
              preparedCount++;
              if (failFirstPreparation && preparedCount === 1) {
                throw new Error("offline_prepare_failure");
              }
              return prepared;
            };
            const auth = new NodeUserAuthorization({
              signer,
              wasmBindings: bindings,
              domain: "offline.invalid",
              spacePrefix: "ops.tinychat.backend",
              tinycloudHosts: ["https://offline.invalid"],
            });
            if (failFirstPreparation) {
              await assert.rejects(() => auth.signIn(), /offline_prepare_failure/);
            }
            const sessions = [];
            for (let renewal = 0; renewal < 3; renewal++) {
              await auth.signIn();
              sessions.push(auth.tinyCloudSession);
            }
            assert.equal(preparedCount, failFirstPreparation ? 4 : 3);
            assert.equal(new Set(sessions.map(session => session.sessionKey)).size, 3);
            assert.equal(new Set(sessions.map(session => session.verificationMethod)).size, 3);
            for (const session of sessions) {
              assert.equal(session.address.toLowerCase(), address);
              assert.equal(session.spaceId, sessions[0].spaceId);
              // Later sign-ins must not overwrite an earlier session's named key.
              assert.equal(manager.getDID(session.sessionKey), session.verificationMethod);
            }
          }
          await exercise(false);
          await exercise(true);
          console.log("session renewal and retry passed");
        `,
        ],
        { timeout: 10_000 },
      );

      expect(probe.stderr.toString()).toBe("");
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString().trim()).toBe(
        "session renewal and retry passed",
      );
    });
  }
});
