import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Service {
  command?: string[];
  networks?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  cap_add?: string[];
  read_only?: boolean;
  user?: string;
}
interface Compose {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
}

const compose = Bun.YAML.parse(readFileSync(new URL("../../docker-compose.phala.yml", import.meta.url), "utf8")) as Compose;
const SECRET = /KEY|TOKEN|SECRET/;

test("the page reader holds no key, no volume and no published port, and is as locked down as the gateway", () => {
  const fetcher = compose.services["bots-fetch"]!;
  expect(fetcher.command).toEqual(["bun", "src/fetch-main.ts"]);
  expect(Object.keys(fetcher.environment ?? {}).filter(name => SECRET.test(name))).toEqual([]);
  expect(fetcher.volumes).toBeUndefined();
  expect(fetcher.ports).toBeUndefined();
  expect(fetcher.cap_add).toBeUndefined();
  expect(fetcher.read_only).toBe(true);
  expect(fetcher.user).toBe("65532:65532");
});

test("the keys stay in the gateway: the search key is there and in no other service", () => {
  const holders = Object.entries(compose.services).filter(([, service]) => Object.keys(service.environment ?? {}).includes("TAVILY_API_KEY")).map(([name]) => name);
  expect(holders).toEqual(["bots-gateway"]);
});

test("the page reader's only networks are the private link it shares with the gateway and its own way out", () => {
  expect(compose.services["bots-fetch"]!.networks).toEqual(["fetch-link", "fetch-out"]);
  expect(compose.networks["fetch-link"]!.internal).toBe(true);
  expect(compose.networks["fetch-out"]!.internal).toBeUndefined();
  const onLink = Object.entries(compose.services).filter(([, service]) => service.networks?.includes("fetch-link")).map(([name]) => name).sort();
  expect(onLink).toEqual(["bots-fetch", "bots-gateway"]);
  const onOut = Object.entries(compose.services).filter(([, service]) => service.networks?.includes("fetch-out")).map(([name]) => name);
  expect(onOut).toEqual(["bots-fetch"]);
});

test("the page reader is not on any network the supervisor, the sandboxes' sockets or the ingress use", () => {
  const fetcherNets = new Set(compose.services["bots-fetch"]!.networks);
  for (const other of ["bots-supervisor", "dstack-ingress"]) {
    expect((compose.services[other]!.networks ?? []).filter(name => fetcherNets.has(name))).toEqual([]);
  }
  expect(compose.services["bots-supervisor"]!.networks).toEqual(["bots-internal"]);
});
