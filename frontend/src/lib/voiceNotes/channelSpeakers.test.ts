import { expect, test } from "bun:test";
import type { FirefliesSentence } from "../connectors/firefliesClient";
import { nameChannelSpeakers } from "./channelSpeakers";

let index = 0;
function sentence(channel: 0 | 1, speakerId: string | undefined, start: number, end: number): FirefliesSentence {
  return { index: index++, speaker_name: speakerId ? `Speaker ${speakerId}` : null, text: "words", start_time: start, end_time: end,
    channel, ...(speakerId ? { speaker_id: speakerId } : {}) };
}
const names = (sentences: FirefliesSentence[]) => nameChannelSpeakers(sentences).map((s) => s.speaker_name);

test("several voices on the other side are numbered in order of first appearance; the microphone side stays Me", () => {
  const named = nameChannelSpeakers([
    sentence(1, "2B", 0, 60), sentence(0, "1A", 60, 70), sentence(1, "2A", 70, 130), sentence(0, "1C", 130, 131), sentence(1, "2B", 131, 190),
  ]);
  expect(named.map((s) => s.speaker_name)).toEqual(["Speaker 1", "Me", "Speaker 2", "Me", "Speaker 1"]);
  expect(named.map((s) => s.speaker_id)).toEqual(["2B", "1A", "2A", "1C", "2B"]);
});

test("one voice on the other side, or none told apart, is Them", () => {
  expect(names([sentence(0, "1A", 0, 5), sentence(1, "2A", 5, 60)])).toEqual(["Me", "Them"]);
  expect(names([sentence(0, undefined, 0, 5), sentence(1, undefined, 5, 60)])).toEqual(["Me", "Them"]);
});

test("a voice with a few seconds of short replies does not turn one caller into two", () => {
  expect(names([sentence(1, "2A", 0, 300), sentence(1, "2B", 301, 302), sentence(0, "1A", 302, 400), sentence(1, "2B", 350, 351)]))
    .toEqual(["Them", "Them", "Me", "Them"]);
});

test("with several real voices, a stray one takes the name of the voice nearest in time", () => {
  expect(names([
    sentence(1, "2A", 0, 300), sentence(1, "2C", 301, 302), sentence(1, "2B", 400, 700), sentence(1, "2C", 399, 400), sentence(1, undefined, 705, 706),
  ])).toEqual(["Speaker 1", "Speaker 1", "Speaker 2", "Speaker 2", "Speaker 2"]);
});

test("a short note keeps both of its voices", () => {
  expect(names([sentence(1, "2A", 0, 8), sentence(1, "2B", 8, 14)])).toEqual(["Speaker 1", "Speaker 2"]);
});

test("a sentence without a channel is left as the engine named it", () => {
  const unplaced: FirefliesSentence = { index: 0, speaker_name: "Speaker A", speaker_id: "A", text: "words", start_time: 0, end_time: 1 };
  expect(nameChannelSpeakers([unplaced])).toEqual([unplaced]);
});
