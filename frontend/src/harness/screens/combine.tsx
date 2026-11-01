// Combine two captures of one meeting (TC-1152 S2c-1) in the real shell: the Combine entry on a meeting, the
// picker, the confirm sheet for a pair that passes and one that does not, the Library row and page of a
// combined meeting, its summary (generating, shown, unavailable with Retry), and Delete. Every screen is the
// rendered path (ShellApp -> CaptureSurface -> LibraryScreen / NoteDetail -> NoteDetailView) over a fake space
// (fixtures/combine.ts): no account, no network, and no model (the summary's call is a fake).
import { useContext, useEffect, useMemo } from "react";

import { COMBINED_ROW_ID, combineScreenSpace, FIREFLIES_DESIGN, FIREFLIES_WEEKLY, NOTETAKER_WEEKLY } from "../fixtures/combine";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import { createRuntimeShim } from "../runtimeShim";
import { PlatformContext } from "@/lib/platform";

/** Taps each selector in turn as it appears (a user's path through the sheet). */
function Taps(props: { selectors: string[] }) {
  useEffect(() => {
    let timer = 0;
    let step = 0;
    const next = () => {
      const target = document.querySelector<HTMLElement>(props.selectors[step] ?? "");
      if (target && target.getClientRects().length > 0) {
        target.click();
        step++;
      }
      if (step < props.selectors.length) timer = window.setTimeout(next, 120);
    };
    timer = window.setTimeout(next, 300);
    return () => window.clearTimeout(timer);
  }, [props.selectors]);
  return null;
}

function CombineShell(props: { combined?: boolean; summary?: boolean; taps?: string[]; hang?: boolean; model?: "hang" | "fail" }) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const space = useMemo(() => {
    const created = combineScreenSpace({ combined: props.combined, summary: props.summary });
    if (props.hang) created.getDelayMs = 60_000;
    return created;
  }, [props.combined, props.summary, props.hang]);
  // The harness never calls a model: Retry meets a call that never answers, or one that fails.
  const summaryComplete = useMemo(() => (props.model === "hang" ? () => new Promise<string>(() => undefined) : () => Promise.reject(new Error("harness: no model"))), [props.model]);
  return (
    <>
      <ShellApp platform={platform} shim={shim} state="ready" captureTcw={space.tcw} summaryComplete={summaryComplete} />
      {props.taps && <Taps selectors={props.taps} />}
    </>
  );
}

const SCREEN = { group: "combine", layout: "pane", displayTitle: true, platform: "ios" } as const;
const note = (id: string) => `/chat/capture/library/${id}`;
const READ = '[data-testid="note-transcript"]:not(:has([role="status"]))';
const ENTRY = '[data-testid="combine-entry"]';
const candidate = (id: string) => `[data-testid="combine-candidate"][data-item-id="${id}"]`;
const OPEN_PICKER = [ENTRY];
const TO_CONFIRM = [ENTRY, candidate(NOTETAKER_WEEKLY.id)];
const TO_REFUSED = [ENTRY, candidate(FIREFLIES_DESIGN.id)];
const GENERATE = '[data-testid="combined-summary-generate"]';

export const combineScreens: HarnessScreen[] = [
  { ...SCREEN, id: "combine-entry", path: note(FIREFLIES_WEEKLY.id), readyWhen: `${ENTRY}`, render: () => <CombineShell /> },
  { ...SCREEN, id: "combine-picker", path: note(FIREFLIES_WEEKLY.id), readyWhen: '[data-testid="combine-sheet"][data-step="pick"] [data-testid="combine-candidate"]', render: () => <CombineShell taps={OPEN_PICKER} /> },
  { ...SCREEN, id: "combine-checking", path: note(FIREFLIES_WEEKLY.id), readyWhen: '[data-testid="combine-sheet"][data-step="analyzing"]', render: () => <CombineShell taps={TO_CONFIRM} hang /> },
  { ...SCREEN, id: "combine-confirm-pass", path: note(FIREFLIES_WEEKLY.id), readyWhen: '[data-testid="combine-confirm"][data-passed="true"]', render: () => <CombineShell taps={TO_CONFIRM} /> },
  { ...SCREEN, id: "combine-confirm-fail", path: note(FIREFLIES_WEEKLY.id), readyWhen: '[data-testid="combine-confirm"][data-passed="false"]', render: () => <CombineShell taps={TO_REFUSED} /> },
  { ...SCREEN, id: "combine-library-row", path: "/chat/capture/library", readyWhen: '[data-testid="library-list"][data-state="ready"]:has([data-testid="library-item"])', render: () => <CombineShell combined /> },
  { ...SCREEN, id: "combine-detail", path: note(COMBINED_ROW_ID), readyWhen: `${READ}:not(:empty)`, render: () => <CombineShell combined /> },
  { ...SCREEN, id: "combine-summary-generating", path: note(COMBINED_ROW_ID), readyWhen: '[data-testid="combined-summary"][data-state="generating"]', render: () => <CombineShell combined model="hang" taps={[GENERATE]} /> },
  { ...SCREEN, id: "combine-summary-shown", path: note(COMBINED_ROW_ID), readyWhen: '[data-testid="combined-summary"][data-state="ready"]', render: () => <CombineShell combined summary /> },
  { ...SCREEN, id: "combine-summary-unavailable", path: note(COMBINED_ROW_ID), readyWhen: '[data-testid="combined-summary"][data-state="unavailable"]', render: () => <CombineShell combined model="fail" taps={[GENERATE]} /> },
  { ...SCREEN, id: "combine-delete-confirm", path: note(COMBINED_ROW_ID), readyWhen: '[data-testid="delete-combined-sheet"]', render: () => <CombineShell combined taps={['[data-testid="combined-delete"]']} /> },
  // TC-1152 v1b-a: the Library shows the combined meeting alone; the page lists its tappable sources; a source opens
  // from it; and after Delete combined the sources are back in the list.
  { ...SCREEN, id: "combine-library-one", path: "/chat/capture/library", readyWhen: '[data-testid="library-list"][data-state="ready"]:has([data-testid="library-item"])', render: () => <CombineShell combined /> },
  { ...SCREEN, id: "combine-detail-sources", path: note(COMBINED_ROW_ID), readyWhen: '[data-testid="combined-member"] a', render: () => <CombineShell combined /> },
  { ...SCREEN, id: "combine-source-opened", path: note(COMBINED_ROW_ID), readyWhen: `${READ}:not(:empty):not(:has([data-testid="combined-members"]))`, render: () => <CombineShell combined taps={[`[data-testid="combined-member"] a[href$="/${FIREFLIES_WEEKLY.id}"]`]} /> },
  { ...SCREEN, id: "combine-library-after-delete", path: note(COMBINED_ROW_ID), readyWhen: `[data-testid="library-list"][data-state="ready"]:has(a[href$="/${FIREFLIES_WEEKLY.id}"])`, render: () => <CombineShell combined taps={['[data-testid="combined-delete"]', '[data-testid="delete-combined-confirm"]']} /> },
  { ...SCREEN, id: "combine-confirm-pass-web", platform: "web", path: note(FIREFLIES_WEEKLY.id), readyWhen: '[data-testid="combine-confirm"][data-passed="true"]', render: () => <CombineShell taps={TO_CONFIRM} /> },
];
