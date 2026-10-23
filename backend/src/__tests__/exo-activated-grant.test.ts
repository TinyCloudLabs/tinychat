import { describe, expect, test } from "bun:test";
import { createExoActivatedGrant, ownerApplicationsSpaceUri, readVersionedKv, type ExoKvAccess } from "../exo/activated-grant.js";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX } from "../delegation-verify.js";

// EIP-55 reference address (checksum case is part of the value).
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const GRANT = { policy: "exo-sync" as const, ownerAddress: OWNER.toLowerCase(), chainId: 1, spaceId: SPACE };

interface FakeKv extends ExoKvAccess {
  calls: string[];
  getResult: unknown;
  listResult: unknown;
}

function fakeKv(): FakeKv {
  const fake: FakeKv = {
    calls: [],
    getResult: { ok: true, data: { data: undefined } },
    listResult: { ok: true, data: { keys: [] } },
    async get(key) {
      fake.calls.push(`get ${key}`);
      return fake.getResult;
    },
    async list(options) {
      fake.calls.push(`list ${options.prefix}`);
      return fake.listResult;
    },
    async put(key) {
      fake.calls.push(`put ${key}`);
      return { ok: true };
    },
    async delete(key) {
      fake.calls.push(`delete ${key}`);
      return { ok: true };
    },
  };
  return fake;
}

describe("ownerApplicationsSpaceUri", () => {
  test("checksums a lowercase owner address", () => {
    expect(ownerApplicationsSpaceUri(OWNER.toLowerCase(), 1)).toBe(SPACE);
  });

  test("refuses a mixed-case address whose checksum is wrong", () => {
    expect(() => ownerApplicationsSpaceUri("0x5aaEb6053F3E94C9b9A09f33669435E7Ef1BeAed", 1)).toThrow();
  });
});

describe("createExoActivatedGrant identity checks", () => {
  test("refuses a transcript-writer grant", () => {
    expect(() => createExoActivatedGrant({ kv: fakeKv() }, { ...GRANT, policy: "transcript-writer" })).toThrow();
  });

  test("refuses a space for another owner or chain", () => {
    const other = `tinycloud:pkh:eip155:1:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359:applications`;
    expect(() => createExoActivatedGrant({ kv: fakeKv() }, { ...GRANT, spaceId: other })).toThrow();
    expect(() => createExoActivatedGrant({ kv: fakeKv() }, { ...GRANT, chainId: 8453 })).toThrow();
  });

  test("accepts a lowercase space id for a checksummed owner (casing is hygiene only)", () => {
    expect(() => createExoActivatedGrant({ kv: fakeKv() }, { ...GRANT, spaceId: SPACE.toLowerCase() })).not.toThrow();
  });
});

describe("createExoActivatedGrant path guard", () => {
  const refused = [
    `${EXO_REQUESTS_PREFIX}../jobs/x`,
    `${EXO_REQUESTS_PREFIX}a//b`,
    `${EXO_REQUESTS_PREFIX}a/`,
    `${EXO_REQUESTS_PREFIX}./x`,
    `${EXO_REQUESTS_PREFIX}%2e%2e/jobs/x`,
    `${EXO_REQUESTS_PREFIX}a%2fb`,
    `${EXO_REQUESTS_PREFIX}a\\b`,
    EXO_REQUESTS_PREFIX,
    `xyz.tinycloud.tinychat/exo/v1/requestsX/a`,
    `${EXO_JOBS_PREFIX}../requests/x`,
    `${EXO_JOBS_PREFIX}a//b`,
    `${EXO_JOBS_PREFIX}a/`,
    `xyz.tinycloud.tinychat/exo/v1/jobs-evil/x`,
    `/${EXO_JOBS_PREFIX}x`,
    `${EXO_JOBS_PREFIX}%2fx`,
  ];

  test.each(refused)("refuses %s before any node call", async (path) => {
    const kv = fakeKv();
    const grant = createExoActivatedGrant({ kv }, GRANT);
    await expect(grant.requestsGet(path)).rejects.toThrow();
    await expect(grant.requestsRemove(path)).rejects.toThrow();
    await expect(grant.jobsGet(path)).rejects.toThrow();
    await expect(grant.jobsPut(path, { a: 1 })).rejects.toThrow();
    await expect(grant.jobsRemove(path)).rejects.toThrow();
    expect(kv.calls).toEqual([]);
  });

  test("refuses a list directory without a trailing slash or outside requests", async () => {
    const kv = fakeKv();
    const grant = createExoActivatedGrant({ kv }, GRANT);
    await expect(grant.requestsList(`${EXO_REQUESTS_PREFIX}sync`)).rejects.toThrow();
    await expect(grant.requestsList(`${EXO_REQUESTS_PREFIX}../`)).rejects.toThrow();
    await expect(grant.requestsList(`${EXO_JOBS_PREFIX}sync/`)).rejects.toThrow();
    expect(kv.calls).toEqual([]);
  });

  test("accepts exact paths under each prefix and calls the node with them unchanged", async () => {
    const kv = fakeKv();
    const grant = createExoActivatedGrant({ kv }, GRANT);
    await grant.requestsRemove(`${EXO_REQUESTS_PREFIX}sync-meetings/abc`);
    await grant.jobsRemove(`${EXO_JOBS_PREFIX}abc`);
    expect(kv.calls).toEqual([`delete ${EXO_REQUESTS_PREFIX}sync-meetings/abc`, `delete ${EXO_JOBS_PREFIX}abc`]);
  });
});

describe("createExoActivatedGrant requestsGet encodings", () => {
  const path = `${EXO_REQUESTS_PREFIX}sync-meetings/abc`;
  const value = { status: "pending" };

  test("parses raw JSON bytes (tinycloud kv put --stdin)", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: true, data: { data: new TextEncoder().encode(JSON.stringify(value)) } };
    expect(await createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).toEqual(value);
    expect(kv.calls).toEqual([`get ${path}`]);
  });

  test("parses a JSON string value", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: true, data: { data: JSON.stringify(value) } };
    expect(await createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).toEqual(value);
  });

  test("returns an already-parsed value unchanged", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: true, data: { data: value } };
    expect(await createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).toEqual(value);
  });

  test("returns undefined for a missing key", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${path}` } };
    expect(await createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).toBeUndefined();
  });

  test("rejects bytes that are not JSON", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: true, data: { data: new TextEncoder().encode("{not json") } };
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).rejects.toThrow();
  });
});

describe("createExoActivatedGrant list and put", () => {
  test("list returns the keys under an exact directory", async () => {
    const kv = fakeKv();
    kv.listResult = { ok: true, data: { keys: [`${EXO_REQUESTS_PREFIX}sync-meetings/a`] } };
    const keys = await createExoActivatedGrant({ kv }, GRANT).requestsList(`${EXO_REQUESTS_PREFIX}sync-meetings/`);
    expect(keys).toEqual([`${EXO_REQUESTS_PREFIX}sync-meetings/a`]);
    expect(kv.calls).toEqual([`list ${EXO_REQUESTS_PREFIX}sync-meetings/`]);
  });

  test("jobsPut writes the value at the exact job path", async () => {
    const kv = fakeKv();
    await createExoActivatedGrant({ kv }, GRANT).jobsPut(`${EXO_JOBS_PREFIX}abc`, { state: "done" });
    expect(kv.calls).toEqual([`put ${EXO_JOBS_PREFIX}abc`]);
  });
});

describe("exo accessor key hardening", () => {
  const requests = `${EXO_REQUESTS_PREFIX}sync-meetings/`;
  const badKeys = [
    `${requests}abc\u0000`,
    `${requests}ab\u0007c`,
    `${requests}ab\u200bc`,
    `${requests}ab c`,
    `${requests}ab\u0441c`,
    `${requests}abc\n`,
    `${requests}ab\uff0fc`,
  ];

  test.each(badKeys)("refuses a key with a control, space, or lookalike character before any node call", async (key) => {
    const kv = fakeKv();
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(key)).rejects.toThrow();
    expect(kv.calls).toEqual([]);
  });

  test("accepts a key of exactly 512 characters and refuses 513", async () => {
    const pad = 512 - requests.length;
    const kv = fakeKv();
    const grant = createExoActivatedGrant({ kv }, GRANT);
    await grant.requestsGet(`${requests}${"a".repeat(pad)}`);
    await expect(grant.requestsGet(`${requests}${"a".repeat(pad + 1)}`)).rejects.toThrow();
    expect(kv.calls).toEqual([`get ${requests}${"a".repeat(pad)}`]);
  });
});

describe("exo accessor stored value hardening", () => {
  const path = `${EXO_REQUESTS_PREFIX}sync-meetings/abc`;

  test("accepts a stored value of exactly 4 KiB and refuses one byte more", async () => {
    const kv = fakeKv();
    const atLimit = JSON.stringify({ s: "a".repeat(4096 - 8) });
    kv.getResult = { ok: true, data: { data: new TextEncoder().encode(atLimit) } };
    expect(await createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).toEqual({ s: "a".repeat(4096 - 8) });
    const overLimit = JSON.stringify({ s: "a".repeat(4096 - 7) });
    kv.getResult = { ok: true, data: { data: new TextEncoder().encode(overLimit) } };
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).rejects.toThrow();
    kv.getResult = { ok: true, data: { data: overLimit } };
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).rejects.toThrow();
  });

  test("refuses a stored value with a byte order mark, as bytes or as a string", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: true, data: { data: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("{}")]) } };
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).rejects.toThrow();
    kv.getResult = { ok: true, data: { data: "\ufeff{}" } };
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).rejects.toThrow();
  });

  test("refuses stored bytes that are not valid UTF-8", async () => {
    const kv = fakeKv();
    kv.getResult = { ok: true, data: { data: new Uint8Array([0x7b, 0xff, 0x7d]) } };
    await expect(createExoActivatedGrant({ kv }, GRANT).requestsGet(path)).rejects.toThrow();
  });

  test("maps a stored JSON null to absent in every encoding", async () => {
    const kv = fakeKv();
    const grant = createExoActivatedGrant({ kv }, GRANT);
    for (const data of [new TextEncoder().encode("null"), "null", null]) {
      kv.getResult = { ok: true, data: { data } };
      expect(await grant.requestsGet(path)).toBeUndefined();
    }
  });
});

describe("ownerApplicationsSpaceUri chain id", () => {
  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("refuses chain id %p", (chainId) => {
    expect(() => ownerApplicationsSpaceUri(OWNER, chainId)).toThrow();
  });

  test("accepts a positive safe integer chain id", () => {
    expect(ownerApplicationsSpaceUri(OWNER, 8453)).toBe(`tinycloud:pkh:eip155:8453:${OWNER}:applications`);
  });
});

describe("createExoActivatedGrant jobs conditional create and list", () => {
  test("jobsPutIfAbsent sends ifNoneMatch and returns false once the key exists", async () => {
    const seen: unknown[] = [];
    let present = false;
    const kv: ExoKvAccess = {
      get: async () => ({ ok: true, data: { data: undefined } }),
      list: async () => ({ ok: true, data: { keys: [] } }),
      put: async (_key, _value, options) => {
        seen.push(options);
        if (options?.ifNoneMatch === "*" && present) {
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "exists" } };
        }
        present = true;
        return { ok: true };
      },
      delete: async () => ({ ok: true }),
    };
    const grant = createExoActivatedGrant({ kv }, GRANT);
    expect(await grant.jobsPutIfAbsent(`${EXO_JOBS_PREFIX}job-1`, { state: "pending" })).toBe(true);
    expect(await grant.jobsPutIfAbsent(`${EXO_JOBS_PREFIX}job-1`, { state: "pending" })).toBe(false);
    expect(seen).toEqual([{ ifNoneMatch: "*" }, { ifNoneMatch: "*" }]);
  });

  test("jobsPutIfAbsent rejects a failure that is not a precondition failure", async () => {
    const kv: ExoKvAccess = {
      get: async () => ({ ok: true, data: { data: undefined } }),
      list: async () => ({ ok: true, data: { keys: [] } }),
      put: async () => ({ ok: false, error: { code: "KV_UNAVAILABLE", message: "down" } }),
      delete: async () => ({ ok: true }),
    };
    const grant = createExoActivatedGrant({ kv }, GRANT);
    await expect(grant.jobsPutIfAbsent(`${EXO_JOBS_PREFIX}job-1`, {})).rejects.toThrow();
  });

  test("jobsList lists under the jobs prefix and returns the keys", async () => {
    const calls: string[] = [];
    const kv: ExoKvAccess = {
      get: async () => ({ ok: true, data: { data: undefined } }),
      list: async (options) => {
        calls.push(options.prefix);
        return { ok: true, data: { keys: [`${EXO_JOBS_PREFIX}job-1`, `${EXO_JOBS_PREFIX}job-2`] } };
      },
      put: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    };
    const grant = createExoActivatedGrant({ kv }, GRANT);
    expect(await grant.jobsList(EXO_JOBS_PREFIX)).toEqual([`${EXO_JOBS_PREFIX}job-1`, `${EXO_JOBS_PREFIX}job-2`]);
    expect(calls).toEqual([EXO_JOBS_PREFIX]);
  });

  test("jobsList refuses a directory outside the jobs prefix or without a trailing slash", async () => {
    const grant = createExoActivatedGrant({ kv: fakeKv() }, GRANT);
    await expect(grant.jobsList(EXO_REQUESTS_PREFIX)).rejects.toThrow();
    await expect(grant.jobsList(`${EXO_JOBS_PREFIX}job-1`)).rejects.toThrow();
  });
});

describe("readVersionedKv etag strength", () => {
  const KEY = "tinycloud/ledger/x";
  const envelope = (etag: string) => ({ ok: true, data: { data: '{"n":1}', headers: { etag } } });

  test("accepts a strong etag and returns it with the decoded value", () => {
    expect(readVersionedKv(envelope('"3"'), KEY)).toEqual({ value: { n: 1 }, etag: '"3"' });
  });

  test("refuses a weak etag, since it cannot back an ifMatch precondition", () => {
    expect(() => readVersionedKv(envelope('W/"3"'), KEY)).toThrow();
  });
});
