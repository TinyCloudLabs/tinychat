import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const resources = resolve(import.meta.dir, "../../../mobile/android/app/src/main/res");

describe("Android status bar theme", () => {
  test("light API-level system bars match the white app surface", () => {
    const styles = readFileSync(resolve(resources, "values/styles.xml"), "utf8");
    expect(styles).toContain('<item name="android:statusBarColor">#FFFFFF</item>');
    expect(styles).toContain('<item name="android:windowLightStatusBar">true</item>');
  });

  test("night system bars match the dark app surface", () => {
    const styles = readFileSync(resolve(resources, "values-night/styles.xml"), "utf8");
    expect(styles).toContain('<item name="android:statusBarColor">#09090B</item>');
    expect(styles).toContain('<item name="android:windowLightStatusBar">false</item>');
    expect(styles).toContain('<item name="android:windowBackground">#09090B</item>');
  });
});
