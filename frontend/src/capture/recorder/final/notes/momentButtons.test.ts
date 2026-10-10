import { describe, expect, test } from "bun:test";
import { buttonizeMoments, momentSeconds } from "./momentButtons";

describe("moment buttons", () => {
  test("a moment's time becomes a button that says where it plays from", () => {
    const html = buttonizeMoments("<ul><li><strong>0:42</strong> Ask Hunter</li></ul>");
    expect(html).toContain('<button type="button" class="nt-moment" data-at="42"');
    expect(html).toContain('aria-label="Play from 0:42"');
    expect(html).toContain("<strong>0:42</strong></button> Ask Hunter");
  });

  test("hours count, and a time that is not a time stays plain text", () => {
    expect(buttonizeMoments("<li><strong>1:02:05</strong> x</li>")).toContain('data-at="3725"');
    expect(buttonizeMoments("<li><strong>0:75</strong> x</li>")).toBe("<li><strong>0:75</strong> x</li>");
    expect(buttonizeMoments("<li>plain <strong>0:42</strong></li>")).toBe("<li>plain <strong>0:42</strong></li>");
    expect(buttonizeMoments("<p><strong>0:42</strong></p>")).toBe("<p><strong>0:42</strong></p>");
  });

  test("seconds are counted as the stored moments count them", () => {
    expect(momentSeconds(0, 42, null)).toBe(42);
    expect(momentSeconds(12, 5, null)).toBe(725);
    expect(momentSeconds(1, 0, 5)).toBe(3605);
    expect(momentSeconds(0, 60, null)).toBeNull();
  });
});
