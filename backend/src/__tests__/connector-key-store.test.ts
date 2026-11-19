import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectorKeyStore, utcDay } from "../services/connector-key-store.js";
import { useRealConnectorStorageInTests } from "./connector-real-storage-test-setup.js";

useRealConnectorStorageInTests();

const MIDNIGHT = Date.parse("2026-11-18T00:00:00.000Z");
const DAY = 86_400_000;
const TODAY = utcDay(MIDNIGHT);
const stores: ConnectorKeyStore[] = [];
const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync("/var/tmp/tc2778-key-store-");
  dirs.push(dir);
  let now = MIDNIGHT;
  return {
    dir,
    file: join(dir, "connector-keys.json"),
    temp: join(dir, "connector-keys.new"),
    moveClock: (ms: number) => { now += ms; },
    open() {
      const store = ConnectorKeyStore.open(dir, () => now);
      stores.push(store);
      return store;
    },
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleCiphertext(key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("sample"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (candidate: Buffer | null): boolean => {
    if (candidate === null) return false;
    try {
      const decipher = createDecipheriv("aes-256-gcm", candidate, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString() === "sample";
    } catch {
      return false;
    }
  };
}

test("starts with 14 independent UTC slots in one owner-only file", () => {
  const f = fixture();
  const store = f.open();
  const slots = store.getLiveDayKeys();
  expect(slots.map(({ day }) => day)).toEqual(Array.from({ length: 14 }, (_, i) => TODAY + i));
  expect(new Set(slots.map(({ key }) => key.toString("base64"))).size).toBe(14);
  expect(slots.every(({ key }) => key.length === 32)).toBe(true);
  expect(store.getDayKey(TODAY - 1)).toBeNull();
  expect(store.getDayKey(TODAY + 14)).toBeNull();
  const stat = statSync(f.file);
  expect(stat.mode & 0o777).toBe(0o600);
  expect(stat.uid).toBe(process.getuid!());
  expect(statSync(f.dir).mode & 0o777).toBe(0o700);
});

test("advances at midnight with one atomic rewrite and removes the expired key", () => {
  const f = fixture();
  const store = f.open();
  const expired = store.getDayKey(TODAY)!;
  const surviving = store.getDayKey(TODAY + 1)!;
  const inode = statSync(f.file).ino;

  f.moveClock(DAY - 1);
  store.advance();
  expect(store.getDayKey(TODAY)!.equals(expired)).toBe(true);
  expect(statSync(f.file).ino).toBe(inode);

  f.moveClock(1);
  store.advance();
  expect(store.getDayKey(TODAY)).toBeNull();
  expect(store.getDayKey(TODAY + 1)!.equals(surviving)).toBe(true);
  expect(store.getDayKey(TODAY + 14)?.length).toBe(32);
  expect(statSync(f.file).ino).not.toBe(inode);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.file, "utf8").includes(expired.toString("base64"))).toBe(false);
  expect(existsSync(f.temp)).toBe(false);
});

test("restarts with the same live keys and skips a missed window in one advance", () => {
  const f = fixture();
  const store = f.open();
  const opens = sampleCiphertext(store.getDayKey(TODAY + 13)!);
  store.close();
  const restarted = f.open();
  expect(opens(restarted.getDayKey(TODAY + 13))).toBe(true);
  f.moveClock(30 * DAY);
  restarted.advance();
  expect(restarted.getDayKey(TODAY + 13)).toBeNull();
  expect(restarted.getLiveDayKeys().map(({ day }) => day)).toEqual(
    Array.from({ length: 14 }, (_, i) => TODAY + 30 + i),
  );
});

test("fails closed when the clock moves back, including across a restart", () => {
  const f = fixture();
  const store = f.open();
  f.moveClock(10);
  store.getDayKey(TODAY);
  f.moveClock(-1);
  expect(() => store.getDayKey(TODAY)).toThrow("Connector key store clock invalid");
  expect(() => store.createCredentialKey()).toThrow("Connector key store clock invalid");

  f.moveClock(DAY);
  // A read alone commits the erased-through day before reporting absence.
  expect(store.getDayKey(TODAY)).toBeNull();
  const afterAdvance = readFileSync(f.file, "utf8");
  store.close();
  f.moveClock(-DAY);
  expect(() => f.open()).toThrow("Connector key store clock invalid");
  expect(readFileSync(f.file, "utf8") === afterAdvance).toBe(true);
  f.moveClock(DAY);
  expect(f.open().getDayKey(TODAY)).toBeNull();
});

test("a second process cannot open the same store, even after the key file is replaced", () => {
  const f = fixture();
  const store = f.open();
  f.moveClock(DAY);
  store.advance();
  const moduleUrl = new URL("../services/connector-key-store.ts", import.meta.url).href;
  const script = `
    import { ConnectorKeyStore } from ${JSON.stringify(moduleUrl)};
    try { ConnectorKeyStore.open(${JSON.stringify(f.dir)}, () => ${MIDNIGHT + DAY}).close(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const openChild = () => Bun.spawnSync([process.execPath, "--no-env-file", "-e", script]);
  const refused = openChild();
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString().trim()).toBe("Connector key store writer lock unavailable");
  store.close();
  expect(openChild().exitCode).toBe(0);
});

test("credential keys survive rotation and restart and are destroyed independently", () => {
  const f = fixture();
  const store = f.open();
  const first = store.createCredentialKey();
  const second = store.createCredentialKey();
  expect(first.key.equals(second.key)).toBe(false);
  f.moveClock(16 * DAY);
  store.advance();
  store.close();

  const restarted = f.open();
  expect(restarted.getCredentialKey(first.id)?.equals(first.key)).toBe(true);
  restarted.destroyCredentialKey(first.id);
  restarted.destroyCredentialKey(first.id);
  restarted.close();

  const reopened = f.open();
  expect(reopened.getCredentialKey(first.id)).toBeNull();
  expect(reopened.getCredentialKey(second.id)?.equals(second.key)).toBe(true);
  expect(readFileSync(f.file, "utf8").includes(first.key.toString("base64"))).toBe(false);
});

test("the wrong day slot cannot open ciphertext", () => {
  const store = fixture().open();
  const opens = sampleCiphertext(store.getDayKey(TODAY)!);
  expect(opens(store.getDayKey(TODAY))).toBe(true);
  expect(opens(store.getDayKey(TODAY + 1))).toBe(false);
});

test("loss of the file makes all previously sealed data unreadable", () => {
  const f = fixture();
  const store = f.open();
  const sealed = store.getLiveDayKeys().map(({ day, key }) => ({ day, opens: sampleCiphertext(key) }));
  const credential = store.createCredentialKey();
  const opensCredential = sampleCiphertext(credential.key);

  unlinkSync(f.file);
  expect(() => store.getDayKey(TODAY)).toThrow("Connector key store unavailable");
  expect(() => store.createCredentialKey()).toThrow("Connector key store unavailable");
  expect(existsSync(f.file)).toBe(false);
  store.close();

  const restarted = f.open();
  for (const { day, opens } of sealed) expect(opens(restarted.getDayKey(day))).toBe(false);
  expect(opensCredential(restarted.getCredentialKey(credential.id))).toBe(false);
});

test("a leftover temporary file is discarded on restart", () => {
  const f = fixture();
  const store = f.open();
  const opens = sampleCiphertext(store.getDayKey(TODAY + 1)!);
  store.close();
  writeFileSync(f.temp, "interrupted write", { mode: 0o600 });
  f.moveClock(DAY);
  expect(opens(f.open().getDayKey(TODAY + 1))).toBe(true);
  expect(existsSync(f.temp)).toBe(false);
});

test("a failed rewrite keeps the committed file and refuses further operations until reopened", () => {
  const f = fixture();
  const store = f.open();
  const opens = sampleCiphertext(store.getDayKey(TODAY + 1)!);
  const inode = statSync(f.file).ino;
  mkdirSync(f.temp);
  f.moveClock(DAY);
  expect(() => store.advance()).toThrow("Connector key store unavailable");
  expect(() => store.getDayKey(TODAY + 1)).toThrow("Connector key store unavailable");
  expect(statSync(f.file).ino).toBe(inode);
  store.close();
  rmSync(f.temp, { recursive: true });
  expect(opens(f.open().getDayKey(TODAY + 1))).toBe(true);
});

test("refuses permissive and corrupt files with a fixed error and no cause", () => {
  const f = fixture();
  f.open().close();
  chmodSync(f.file, 0o644);
  expect(() => f.open()).toThrow("Connector key store file invalid");
  chmodSync(f.file, 0o600);
  writeFileSync(f.file, "invalid payload");
  try {
    f.open();
    throw new Error("accepted corrupt file");
  } catch (error) {
    expect((error as Error).message).toBe("Connector key store file invalid");
    expect((error as Error).cause).toBeUndefined();
  }
});
