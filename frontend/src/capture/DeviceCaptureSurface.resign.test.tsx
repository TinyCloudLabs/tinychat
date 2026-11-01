import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRecorderProvider } from "./recorder/RecorderProvider";
import { DeviceCaptureSurface } from "./DeviceCaptureSurface";
import { MANIFEST_RESIGN_NOTICE } from "@/lib/manifestRevision";
import { screenFor } from "@/shell/routes";
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin } from "@/lib/voiceNotes/onDeviceStt";
import { __resetOnDeviceSttStoreForTests } from "@/lib/voiceNotes/onDeviceSttStore";

const nativeStt = OnDeviceStt;
beforeAll(() => {
  __setOnDeviceSttForTests({
    status: async () => ({ models: [], pack: "full", autoDownload: false, download: { policy: "system", state: "idle" }, engine: "apple-speech", appleSpeech: "ready", queue: [] }),
    addListener: async () => ({ remove: async () => {} }),
  } as unknown as OnDeviceSttPlugin);
  __resetOnDeviceSttStoreForTests();
});
afterAll(() => { __setOnDeviceSttForTests(nativeStt); __resetOnDeviceSttStoreForTests(); });

function render(props: { offline?: boolean; did?: string | null; error?: string | null; resign?: boolean }): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={["/chat/capture"]}>
    <StaticRecorderProvider value={{ signedIn: false, available: true }}>
      <DeviceCaptureSurface did={props.did ?? null} offline={props.offline ?? false} error={props.error ?? null} resign={props.resign}
        onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} />
    </StaticRecorderProvider>
  </MemoryRouter>);
}

test("the forced re-sign shows the re-sign notice and Sign in, not a sign-in failure, and the recorder stays available", () => {
  const html = render({ error: MANIFEST_RESIGN_NOTICE, resign: true });
  expect(html).toContain(MANIFEST_RESIGN_NOTICE);
  expect(html).toContain("Sign in</button>");
  expect(html).not.toContain("Couldn&#x27;t sign in");
  expect(html).toContain("Record</button>");
  expect(html).toContain("Recordings stay on this browser until you sign in.");
});

test("a genuine sign-in failure still shows the failure, not the re-sign notice", () => {
  const html = render({ error: "openkey exploded" });
  expect(html).toContain("Couldn&#x27;t sign in. Try again.");
  expect(html).not.toContain(MANIFEST_RESIGN_NOTICE);
});

test("the re-sign notice is not shown while offline or for a signed-in session", () => {
  expect(render({ offline: true, error: MANIFEST_RESIGN_NOTICE, resign: true })).not.toContain(MANIFEST_RESIGN_NOTICE);
  expect(render({ did: "did:test", error: MANIFEST_RESIGN_NOTICE, resign: true })).not.toContain(MANIFEST_RESIGN_NOTICE);
});
