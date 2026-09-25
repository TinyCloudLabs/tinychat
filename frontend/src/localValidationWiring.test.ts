import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The store tests exercise writes. These checks pin the entry-point gates that
// must apply before React mounts any logged-in storage consumer.
test("local login isolates both fresh and restored sessions before mounting consumers", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(source).toContain(
    "setTcw(LOCAL_VALIDATION ? useLocalCanvasStorage(useLocalThreadStorage(restored.tcw)) : restored.tcw)",
  );
  expect(source).toContain(
    "setTcw(LOCAL_VALIDATION ? useLocalCanvasStorage(useLocalThreadStorage(signedTcw)) : signedTcw)",
  );
  expect(source).toContain("autoCreateSpace: !LOCAL_VALIDATION");
  expect(source).toContain("await prepareLocalSignIn(localTcw)");
  expect(source.indexOf("await prepareLocalSignIn(localTcw)") < source.indexOf("await localTcw.signIn")).toBe(true);
  for (const component of ["BackgroundDrainer", "GmeetSessionSync", "BackendReconciler"]) {
    expect(source).toContain(`{!LOCAL_VALIDATION && state === "ready" && tcw && (\n        <${component}`);
  }
  expect(source).toContain("const showSettings = !LOCAL_VALIDATION &&");
  expect(source).toContain("const showConnectors = !LOCAL_VALIDATION &&");
  expect(source).toContain("connectorsSurface={LOCAL_VALIDATION ? null :");
});

test("fresh agent consent sessions apply local guards before signing in", () => {
  const source = readFileSync(new URL("./lib/agentDelegation.ts", import.meta.url), "utf8");
  expect(source.split("if (localValidationEnabled()) await prepareLocalSignIn(tcw);")).toHaveLength(3);
  expect(source.split("...(localValidationEnabled() ? { autoCreateSpace: false } : {})")).toHaveLength(3);
});
