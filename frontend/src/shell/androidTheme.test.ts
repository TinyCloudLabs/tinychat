import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const resources = resolve(import.meta.dir, "../../../mobile/android/app/src/main/res");

describe("Android status bar theme", () => {
  test("light API-level system bars match the white app surface", () => {
    const styles = readFileSync(resolve(resources, "values/styles.xml"), "utf8");
    const colors = readFileSync(resolve(resources, "values/colors.xml"), "utf8");
    const bools = readFileSync(resolve(resources, "values/bools.xml"), "utf8");
    expect(styles).toContain('<item name="android:statusBarColor">@color/app_surface</item>');
    expect(colors).toContain('<color name="app_surface">#FFFFFF</color>');
    expect(bools).toContain('<bool name="app_light_status_bar">true</bool>');
  });

  test("night system bars match the dark app surface", () => {
    const colors = readFileSync(resolve(resources, "values-night/colors.xml"), "utf8");
    const bools = readFileSync(resolve(resources, "values-night/bools.xml"), "utf8");
    expect(colors).toContain('<color name="app_surface">#09090B</color>');
    expect(bools).toContain('<bool name="app_light_status_bar">false</bool>');
  });
});
