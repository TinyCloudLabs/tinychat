// TC-1152 S2c-1: runs the pure stitcher off the UI thread (see stitchRunner.ts).
import { StitchInputError, stitchMeetings, type MeetingSnapshot, type StitchOptions, type StitchResult } from "@tinyboilerplate/core";

export interface StitchRequest { request: number; a: MeetingSnapshot; b: MeetingSnapshot; options: StitchOptions }
export type StitchReply =
  | { request: number; result: StitchResult }
  | { request: number; error: { input: boolean; message: string } };

self.onmessage = (event: MessageEvent<StitchRequest>) => {
  const { request, a, b, options } = event.data;
  try {
    self.postMessage({ request, result: stitchMeetings(a, b, options) } satisfies StitchReply);
  } catch (error) {
    self.postMessage({ request, error: { input: error instanceof StitchInputError, message: error instanceof Error ? error.message : String(error) } } satisfies StitchReply);
  }
};
