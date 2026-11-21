import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";

const restoreDom = installDom();
afterAll(restoreDom);
const { createRoot } = await import("react-dom/client");
const { MeetingSourcesFeature } = await import("@/capture/meetingSources/MeetingSourcesDialog");

const tcw = { sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }) }) } } as unknown as TinyCloudWeb;
const sessionStore = { getToken: () => null } as unknown as SessionStore;

test("the entry and rows agree on whether Granola is offered", async () => {
  const enabled = import.meta.env.VITE_GRANOLA_CONNECTOR_ENABLED === "true";
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryRouter>
      <MeetingSourcesFeature tcw={tcw} backendUrl="https://backend.invalid" sessionStore={sessionStore} initialOpen />
    </MemoryRouter>));
    expect(Array.from(document.querySelectorAll("[data-source]"), row => row.getAttribute("data-source"))).toEqual(
      enabled ? ["fireflies", "google-meet", "granola"] : ["fireflies", "google-meet"],
    );
    expect(host.querySelector(".ms-entry-sub")?.textContent).toBe(
      enabled ? "Fireflies, Google Meet and Granola" : "Fireflies and Google Meet",
    );
    if (enabled) {
      const actions = document.querySelectorAll('[data-source="granola"] button');
      expect(Array.from(actions, button => button.textContent)).toContain("Connect");
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
