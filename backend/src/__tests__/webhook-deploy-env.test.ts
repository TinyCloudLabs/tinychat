import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

import { assertStrongSecret } from "../services/webhook-tokens.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const defaultWorkflowPath = resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml");
const composePath = resolve(repoRoot, "docker-compose.phala.yml");
const envExamplePath = resolve(repoRoot, "backend/.env.example");

type DeployStep = { name?: string; env?: Record<string, unknown>; run?: string };
type DeployWorkflow = {
  jobs?: { deploy?: { steps?: DeployStep[] } };
};
type PhalaCompose = {
  services?: Record<string, { environment?: Record<string, string> }>;
};

/**
 * The four vars §7.3 names, plus the tunables that ARE exposed in this build
 * (`connector-drain.ts` reads all three). Each must ride the four-place dance or the
 * Phala CVM silently drops it: `allowed_envs` is frozen at CVM creation and is derived
 * from the ENV_FILE keys the deploy step writes — there is no static list. A var present
 * in the step `env:` block but missing from the `printf` block therefore vanishes at
 * injection time with no error anywhere, which is exactly how /api/agent lost web search
 * on 2026-07-07.
 */
const REQUIRED_KEYS = [
  "CONNECTOR_WEBHOOKS_ENABLED",
  "WEBHOOK_HMAC_MASTER",
  "WEBHOOK_HMAC_MASTER_PREV",
  "LOG_HASH_SALT",
  // The pinned public callback origin. Rides the same dance: dropped at injection it falls
  // back to the request's Host header, which is exactly the derivation it exists to replace.
  "CONNECTOR_WEBHOOK_PUBLIC_ORIGIN",
  // W9's Host-header allowlist on the public delivery route (backend-ingest plan §10; findings
  // §6 control 6) and W9/D4's single-instance seat id. Both ride the dance for the same
  // allowed_envs freeze reason as the ingest vars below: a var first added on the deploy that
  // means to use it is a var that silently never arrives — and here that would mean either the
  // host check silently degrading to "derived", or an operator's pinned instance id vanishing so
  // a redeploy waits out the lease TTL with ingest stopped.
  "CONNECTOR_WEBHOOK_HOST_ALLOWLIST",
  "CONNECTOR_INGEST_INSTANCE_ID",
  // W1's backend-ingest flag (backend-ingest plan §8.1 / §12.1). Dark by default and NOT
  // enabled anywhere shared — but it has to ride the dance NOW, because `allowed_envs` is
  // frozen at CVM creation: a var first added on the deploy that means to turn the feature on
  // is a var that silently never arrives.
  "CONNECTOR_BACKEND_INGEST_ENABLED",
  // W2's custody vars (backend-ingest plan §6.2). Same freeze argument as the flag above: they
  // are only READ when the flag is armed, but a var first added on the deploy that means to arm
  // it is a var that silently never arrives — and here "never arrives" means the backend refuses
  // to boot with the flag on, or (worse) that the credential master changes across a redeploy
  // and every stored credential becomes undecryptable.
  "CONNECTOR_CREDENTIAL_MASTER",
  // W4's content master (backend-ingest plan §8.1 W4 / DECISIONS D3). Same freeze argument, and
  // the same orphaning failure one invariant further along: lose this across a redeploy and
  // every stored MEETING becomes undecryptable, not just every credential.
  "CONNECTOR_CONTENT_MASTER",
  "FIREFLIES_OAUTH_CLIENT_ID",
  "FIREFLIES_OAUTH_CLIENT_SECRET",
  "FIREFLIES_OAUTH_REDIRECT_URI",
  "CONNECTOR_DRAIN_INTERVAL_MS",
  "CONNECTOR_A_FETCH_CEILING_PER_HOUR",
  "CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR",
] as const;

/**
 * The secrets §7.6 requires a CSPRNG generation line for. `CONNECTOR_CREDENTIAL_MASTER` and
 * `CONNECTOR_CONTENT_MASTER` join them under the same rule (backend-ingest §6.2, §8.1 W4):
 * generated the same way, never reused (each other included), never sampled in this file. The
 * Fireflies OAuth client secret is NOT here — it is issued by the provider, so there is nothing
 * for us to generate.
 */
const SECRET_KEYS = [
  "WEBHOOK_HMAC_MASTER",
  "WEBHOOK_HMAC_MASTER_PREV",
  "LOG_HASH_SALT",
  "CONNECTOR_CREDENTIAL_MASTER",
  "CONNECTOR_CONTENT_MASTER",
] as const;

function readWorkflow(): DeployWorkflow {
  return loadYaml(readFileSync(defaultWorkflowPath, "utf8")) as DeployWorkflow;
}

function deployEnvWriter(workflow: DeployWorkflow): DeployStep | undefined {
  return workflow.jobs?.deploy?.steps?.find(
    (step) => typeof step.run === "string" && step.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
  );
}

function publicApiProbe(workflow: DeployWorkflow): DeployStep | undefined {
  return workflow.jobs?.deploy?.steps?.find((step) => step.name === "Verify public API");
}

function backendComposeEnv(): Record<string, string> {
  const compose = loadYaml(readFileSync(composePath, "utf8")) as PhalaCompose;
  return compose.services?.["tinychat-backend"]?.environment ?? {};
}

function envExample(): string {
  return readFileSync(envExamplePath, "utf8");
}

describe("Phala backend deploy connector-webhook environment", () => {
  test("declares every connector-webhook setting in the deploy step env: block", () => {
    const writer = deployEnvWriter(readWorkflow());

    expect(writer?.env).toBeTruthy();
    for (const key of REQUIRED_KEYS) {
      expect(Object.hasOwn(writer?.env ?? {}, key)).toBe(true);
    }
  });

  test("writes every one of them into the ENV_FILE the allowed_envs sync reads", () => {
    const writer = deployEnvWriter(readWorkflow());

    expect(writer?.run).toBeTruthy();
    for (const key of REQUIRED_KEYS) {
      expect(writer?.run).toContain(`"${key}=`);
    }
  });

  test("passes every one of them through docker-compose.phala.yml to the container", () => {
    const environment = backendComposeEnv();

    for (const key of REQUIRED_KEYS) {
      expect(Object.hasOwn(environment, key)).toBe(true);
      // `${NAME...}` interpolation, not a baked literal: the value comes from the
      // encrypted CVM env, and a hard-coded one here would outrank it silently.
      expect(String(environment[key])).toContain(`\${${key}`);
    }
  });

  test("the flag ships dark by default in both the deploy env and the compose file", () => {
    const writer = deployEnvWriter(readWorkflow());

    expect(String(writer?.env?.CONNECTOR_WEBHOOKS_ENABLED)).toContain("'false'");
    expect(writer?.run).toContain('"CONNECTOR_WEBHOOKS_ENABLED=${CONNECTOR_WEBHOOKS_ENABLED:-false}"');
    expect(backendComposeEnv().CONNECTOR_WEBHOOKS_ENABLED).toBe("${CONNECTOR_WEBHOOKS_ENABLED:-false}");
  });

  test("the backend-ingest flag ships dark in both the deploy env and the compose file", () => {
    const writer = deployEnvWriter(readWorkflow());

    // Dark DEFAULT, and dark at every layer: this flag reverses two shipped invariants for the
    // addresses in its cohort (plan §11), so "unset" must never read as "on" anywhere.
    expect(String(writer?.env?.CONNECTOR_BACKEND_INGEST_ENABLED)).toContain("'false'");
    expect(writer?.run).toContain(
      '"CONNECTOR_BACKEND_INGEST_ENABLED=${CONNECTOR_BACKEND_INGEST_ENABLED:-false}"',
    );
    expect(backendComposeEnv().CONNECTOR_BACKEND_INGEST_ENABLED).toBe(
      "${CONNECTOR_BACKEND_INGEST_ENABLED:-false}",
    );
    expect(
      /^CONNECTOR_BACKEND_INGEST_ENABLED=(.*)$/m.exec(envExample())?.[1],
    ).toBe("false");
  });

  /**
   * W6b's mount canary. The 401/404 pair is the ONLY post-deploy signal that separates
   * "shipped dark on purpose" from "the env vanished at injection and background sync is
   * silently dead" — the 2026-07-07 failure mode, one route over.
   */
  test("the post-deploy probe asserts 401 when the flag is on and 404 while it is off", () => {
    const probe = publicApiProbe(readWorkflow());

    expect(probe?.run).toBeTruthy();
    // A junk-signature POST at the two-segment raw mount, not a GET at a companion.
    expect(probe?.run).toContain("/api/connectors/webhooks/fireflies/probe-token");
    expect(probe?.run).toContain("-X POST");
    expect(probe?.run).toContain("x-hub-signature: sha256=");
    // Both halves of the canary, and the flag that selects between them.
    expect(probe?.run).toContain("WEBHOOK_EXPECT=401");
    expect(probe?.run).toContain("WEBHOOK_EXPECT=404");
    expect(probe?.run).toContain('[ "${CONNECTOR_WEBHOOKS_ENABLED:-false}" = "true" ]');
    // The probe reads the flag this deploy shipped rather than assuming one.
    expect(Object.hasOwn(probe?.env ?? {}, "CONNECTOR_WEBHOOKS_ENABLED")).toBe(true);
    // A mismatch must FAIL the deploy, never just print.
    expect(probe?.run).toContain('if [ "$WEBHOOK_STATUS" != "$WEBHOOK_EXPECT" ]');
    expect(probe?.run).toContain("Connector webhook probe failed");
  });

  test(".env.example declares every REQUIRED_KEY as an uncommented assignment", () => {
    // The three tunables were commented-out sample lines while the other four were explicit
    // assignments, and a commented line reads as "optional, not deployment-relevant" — which is
    // exactly wrong for a var that rides the four-place `allowed_envs` dance above. Declared and
    // EMPTY: an empty value is the documented "use the code default", and a non-empty typo is a
    // hard startup error rather than a silent revert (`positiveIntFromEnv`).
    const contents = envExample();
    for (const key of REQUIRED_KEYS) {
      const assignment = new RegExp(`^${key}=(.*)$`, "m").exec(contents);
      expect({ key, declared: assignment !== null }).toEqual({ key, declared: true });
    }
    for (const key of [
      "CONNECTOR_DRAIN_INTERVAL_MS",
      "CONNECTOR_A_FETCH_CEILING_PER_HOUR",
      "CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR",
    ] as const) {
      expect(new RegExp(`^${key}=(.*)$`, "m").exec(contents)?.[1]).toBe("");
    }
  });

  test(".env.example documents CSPRNG generation for all three secrets and ships no sample secret", () => {
    const contents = envExample();

    for (const key of SECRET_KEYS) {
      // Declared, and declared EMPTY — a sample value here is a value someone deploys.
      const assignment = new RegExp(`^${key}=(.*)$`, "m").exec(contents);
      expect(assignment).not.toBeNull();
      expect(assignment?.[1]).toBe("");
    }

    // One generation line per secret, and it is the documented one.
    const generationLines = contents.match(/^#\s+openssl rand -base64 32$/gm) ?? [];
    expect(generationLines.length).toBe(SECRET_KEYS.length);
    expect(contents).toContain("MUST NOT be derived from WEBHOOK_HMAC_MASTER");

    // Belt and braces: nothing anywhere in the file — commented-out lines included —
    // assigns one of these names a value the strength gate would ACCEPT. A sample
    // secret that boots is a sample secret that reaches production.
    for (const match of contents.matchAll(
      /^#?\s*(WEBHOOK_HMAC_MASTER(?:_PREV)?|LOG_HASH_SALT|CONNECTOR_(?:CREDENTIAL|CONTENT)_MASTER)=(.+)$/gm,
    )) {
      expect(() => assertStrongSecret(match[1], match[2], { quiet: true })).toThrow();
    }
  });
});

describe("connector-webhook secret strength gate", () => {
  test("rejects a missing value for each fatal deploy secret", () => {
    for (const key of ["WEBHOOK_HMAC_MASTER", "LOG_HASH_SALT"] as const) {
      expect(() => assertStrongSecret(key, undefined, { quiet: true })).toThrow(
        `[startup] FATAL: ${key} is missing or too weak (need >=32 decoded bytes)`,
      );
      expect(() => assertStrongSecret(key, "", { quiet: true })).toThrow();
      expect(() => assertStrongSecret(key, "   ", { quiet: true })).toThrow();
    }
  });

  test("rejects anything decoding to fewer than 32 bytes", () => {
    // 31 bytes hex, 31 bytes base64, and a short passphrase.
    expect(() => assertStrongSecret("WEBHOOK_HMAC_MASTER", "ab".repeat(31), { quiet: true })).toThrow();
    expect(() =>
      assertStrongSecret("LOG_HASH_SALT", Buffer.alloc(31, 3).toString("base64"), { quiet: true }),
    ).toThrow();
    expect(() => assertStrongSecret("WEBHOOK_HMAC_MASTER", "hunter2", { quiet: true })).toThrow();
    // The documented generation path clears the floor exactly.
    expect(assertStrongSecret("WEBHOOK_HMAC_MASTER", Buffer.alloc(32, 5).toString("base64"), { quiet: true })).toBe(32);
  });

  test("rejects every placeholder on the deny-list, including long-enough ones", () => {
    const placeholders = [
      "changeme",
      "change-me",
      "secret",
      "test",
      "password",
      "placeholder",
      "example",
      "dev",
      "local",
      "none",
      "off",
      // Long enough to clear a naive length check, still obviously not a secret.
      "changeme-changeme-changeme-changeme-changeme",
      "replace-me-with-a-real-value-before-deploying",
      "your-secret-goes-here-your-secret-goes-here-x",
      "openssl rand -base64 32",
      "a".repeat(64),
    ];
    for (const placeholder of placeholders) {
      expect(() => assertStrongSecret("WEBHOOK_HMAC_MASTER", placeholder, { quiet: true })).toThrow();
    }
  });

  test("the _PREV grace key may be absent but is gated the moment it is present", () => {
    expect(assertStrongSecret("WEBHOOK_HMAC_MASTER_PREV", undefined, { optional: true, quiet: true })).toBeNull();
    expect(assertStrongSecret("WEBHOOK_HMAC_MASTER_PREV", "", { optional: true, quiet: true })).toBeNull();
    expect(() =>
      assertStrongSecret("WEBHOOK_HMAC_MASTER_PREV", "changeme", { optional: true, quiet: true }),
    ).toThrow();
  });

  test("boot logs the accepted LENGTH and never the value", () => {
    const master = Buffer.alloc(32, 11).toString("base64");
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      assertStrongSecret("WEBHOOK_HMAC_MASTER", master);
    } finally {
      console.log = originalLog;
    }

    expect(lines.join("\n")).toContain("WEBHOOK_HMAC_MASTER accepted (32 decoded bytes)");
    for (const line of lines) {
      expect(line).not.toContain(master);
      // Not even a prefix: a stable fragment of the master is still a fragment of the master.
      expect(line).not.toContain(master.slice(0, 8));
    }
  });
});
