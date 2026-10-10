import { expect, test } from "bun:test";
import { leaseWhisperServer } from "./whisperServerLease";

test("meeting and note holders share a model and the last holder stops it", async () => {
  let starts = 0;
  let stops = 0;
  const start = async () => { starts++; return "http://fixture"; };
  const stop = async () => { stops++; };
  const meeting = leaseWhisperServer("QuantizedTinyEn", start, stop);
  const note = leaseWhisperServer("QuantizedTinyEn", start, stop);
  expect(await meeting.ready).toBe("http://fixture");
  expect(await note.ready).toBe("http://fixture");
  expect(starts).toBe(1);
  note.release();
  expect(stops).toBe(0);
  meeting.release();
  expect(stops).toBe(1);
});

test("another model waits until the current holder releases the server", async () => {
  const calls: string[] = [];
  const first = leaseWhisperServer("QuantizedTinyEn", async () => { calls.push("tiny"); return "tiny"; },
    async () => { calls.push("stop-tiny"); });
  await first.ready;
  const second = leaseWhisperServer("QuantizedBase", async () => { calls.push("base"); return "base"; },
    async () => { calls.push("stop-base"); });
  await Promise.resolve();
  expect(calls).toEqual(["tiny"]);
  first.release();
  await second.ready;
  expect(calls).toEqual(["tiny", "stop-tiny", "base"]);
  second.release();
});
