import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(resolve(import.meta.dir, "../../../.github/workflows/deploy-backend-phala.yml"), "utf8");
const dnsStep = workflow.split("      - name: Verify custom domain DNS\n")[1]!;
const code = dnsStep.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)!;
if (!code) throw new Error("Deployment DNS check not found");

const gateway = "gateway.dstack-pha-prod5.phala.network";
const alias = "_.dstack-pha-prod5.phala.network";
const appId = "synthetic-app";

async function check(cnames: string[] | Error, txt: string[][] | Error = [[`${appId}:443`]], advertised = gateway) {
  const errors: string[] = [];
  const process = {
    env: { PHALA_INGRESS_DOMAIN: "api.example.com", PHALA_GATEWAY_CNAME: advertised, PHALA_APP_ID: appId },
    exitCode: 0,
    exit(code: number) { this.exitCode = code; },
  };
  // Execute the workflow's actual validator; replace only external DNS and process I/O.
  await runInNewContext(code[1]!, {
    process,
    console: { log() {}, error(message: string) { errors.push(message); } },
    require(name: string) {
      if (name !== "node:dns") throw new Error(`Unexpected dependency: ${name}`);
      return { promises: {
        async resolveCname(host: string) {
          expect(host).toBe("api.example.com");
          if (cnames instanceof Error) throw cnames;
          return cnames;
        },
        async resolveTxt(host: string) {
          expect(host).toBe("_dstack-app-address.api.example.com");
          if (txt instanceof Error) throw txt;
          return txt;
        },
      } };
    },
  });
  return { exitCode: process.exitCode, errors, advertised: process.env.PHALA_GATEWAY_CNAME };
}

describe("Phala deployment DNS gate", () => {
  test.each([gateway, `${gateway}.`, alias, `${alias}.`])("accepts same-gateway CNAME %s with correct app-address TXT", async cname => {
    const result = await check([cname], [[appId, ":443"]], `${gateway}.`);
    expect(result).toEqual({ exitCode: 0, errors: [], advertised: `${gateway}.` });
  });

  test.each([
    "_.dstack-pha-prod4.phala.network",
    "gateway.dstack-pha-prod4.phala.network",
    "_.dstack-pha-prod5.phala.network.attacker.example",
    "_.other.phala.network",
    "66.220.6.105",
  ])("rejects unrelated CNAME %s", async cname => {
    const result = await check([cname]);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("Phala DNS CNAME mismatch");
  });

  test.each(["gateway.example.com", "gateway.dstack-pha-prod5.phala.network.attacker.example"])("does not derive an underscore alias for %s", async advertised => {
    expect((await check([advertised.replace(/^gateway\./, "_.")], undefined, advertised)).exitCode).toBe(1);
  });

  test.each([
    { name: "missing", value: [] },
    { name: "wrong app", value: [["other-app:443"]] },
    { name: "wrong port", value: [[`${appId}:3001`]] },
    { name: "lookup failure", value: new Error("synthetic lookup failure") },
  ])("still rejects app-address TXT: $name", async ({ value }) => {
    const result = await check([alias], value);
    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("Phala DNS TXT mismatch");
  });

  test.each([{ value: [] }, { value: new Error("synthetic lookup failure") }])("rejects absent or unavailable CNAME (%j)", async ({ value }) => {
    expect((await check(value)).exitCode).toBe(1);
  });
});
