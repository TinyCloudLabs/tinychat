// The notetaker's meeting-link field takes a whole pasted calendar invite (TC-2181).
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { installDom } from "@/test/dom";
import { TranscriberView, normalizeMeetingUrl, type TranscriberViewProps } from "./TranscriberSection";

const SAM_INVITE = "TinyCloud Team Sync Wednesday, October 28 · 8:00 – 8:30am Time zone: America/New_York Google Meet joining info Video call link: https://meet.google.com/yas-buib-ppd Or dial: (DE) +49 30 300195060 PIN: 933 894 199 6748# More phone numbers: https://tel.meet/yas-buib-ppd?pin=9338941996748";
const noop = () => {};

describe("the meeting-link field", () => {
  test("a pasted invite reaches the submit handler instead of being stopped by native URL validation", async () => {
    const cleanup = installDom();
    try {
      let submits = 0;
      const props: TranscriberViewProps = {
        listStatus: "ready", meetings: [], saved: {}, form: { url: SAM_INVITE, botName: "", submitting: false, error: null },
        busyId: null, open: null, onUrlChange: noop, onBotNameChange: noop, onSubmit: () => { submits += 1; },
        onRefresh: noop, onStop: noop, onToggleTranscript: noop, onRemove: noop,
      };
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => root.render(<MemoryRouter><TranscriberView {...props} /></MemoryRouter>));
      const input = document.querySelector<HTMLInputElement>("#transcriber-meeting-url")!;
      expect(input.value).toBe(SAM_INVITE);
      expect(input.validity.typeMismatch).toBe(false);
      const form = input.form!;
      expect(form.checkValidity()).toBe(true);
      await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
      expect(submits).toBe(1);
      await act(async () => root.unmount());
    } finally { cleanup(); }
  });

  test("a pasted invite and its Meet link share one dedupe key", () => {
    expect(normalizeMeetingUrl(SAM_INVITE)).toBe("https://meet.google.com/yas-buib-ppd");
  });
});
