import { describe, expect, test } from "bun:test";

import { isChatViewPath } from "./chatViewPath";
import { CONNECTORS_LIBRARY_PATH, CONNECTORS_SOURCES_PATH } from "../shell/routes";

describe("isChatViewPath", () => {
  test("the chat view is /chat, with or without one trailing slash", () => {
    expect(isChatViewPath("/chat")).toBe(true);
    expect(isChatViewPath("/chat/")).toBe(true);
  });

  test("threads have no route of their own — nothing below /chat is a chat view", () => {
    expect(isChatViewPath("/chat/thread-123")).toBe(false);
    expect(isChatViewPath("/chat//")).toBe(false);
  });

  test("Connectors (Sources and Library) is not a chat view", () => {
    expect(isChatViewPath(CONNECTORS_SOURCES_PATH)).toBe(false);
    expect(isChatViewPath(`${CONNECTORS_SOURCES_PATH}/`)).toBe(false);
    expect(isChatViewPath(CONNECTORS_LIBRARY_PATH)).toBe(false);
    expect(isChatViewPath(`${CONNECTORS_LIBRARY_PATH}/`)).toBe(false);
  });

  test("Capture, its Library and a note are not chat views", () => {
    expect(isChatViewPath("/chat/capture")).toBe(false);
    expect(isChatViewPath("/chat/capture/")).toBe(false);
    expect(isChatViewPath("/chat/capture/library")).toBe(false);
    expect(isChatViewPath("/chat/capture/library/")).toBe(false);
    expect(isChatViewPath("/chat/capture/library/7f3a")).toBe(false);
  });

  test("Settings is not a chat view, trailing slash included", () => {
    expect(isChatViewPath("/chat/settings")).toBe(false);
    expect(isChatViewPath("/chat/settings/")).toBe(false);
  });

  test("the legacy /chat/meetings redirect and unknown deep links are not chat views", () => {
    expect(isChatViewPath("/chat/meetings")).toBe(false);
    expect(isChatViewPath("/chat/meetings/")).toBe(false);
    expect(isChatViewPath("/chat/foo")).toBe(false);
    expect(isChatViewPath("/chat/foo/")).toBe(false);
  });

  test("addresses outside /chat are not chat views", () => {
    expect(isChatViewPath("/")).toBe(false);
    expect(isChatViewPath("")).toBe(false);
    expect(isChatViewPath("/chats")).toBe(false);
    expect(isChatViewPath("/other/chat")).toBe(false);
  });
});
