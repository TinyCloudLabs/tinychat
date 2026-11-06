// Feed design rig entry (frontend/feed-rig.html). Without ?frame=1 it shows the state
// picker and a phone or desktop frame; with ?frame=1 it renders the real Home shell and
// feed for ?state=<id> from feed-fixture.json.
import "@/index.css";
import { StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

import { FeedViewEntries } from "@/feed/FeedView";
import { AppsPage } from "@/home/AppsPage";
import { AppShell } from "@/shell/AppShell";
import { screenFor } from "@/shell/routes";
import { SignedOutSurface } from "@/shell/SignedOutSurface";
import fixtureJson from "feed-rig-fixture";
import { failingSource, fixtureSource, loadingSource, type RigFixture, type RigState } from "./fixtureSource";

const fixture = fixtureJson as unknown as RigFixture;
const stateIds = Object.keys(fixture.states);
const params = new URLSearchParams(window.location.search);
const stateId = stateIds.includes(params.get("state") ?? "") ? params.get("state")! : stateIds[0]!;
const width = params.get("w") === "1280" ? "1280" : "390";

function ShellFrame({ state }: { state: RigState }) {
  const { pathname } = useLocation();
  const screen = useMemo(() => screenFor(pathname), [pathname]);
  const source = useMemo(() =>
    state.kind === "feed" ? fixtureSource(state.snapshot, { failSaves: state.failSaves })
      : state.kind === "loading" ? loadingSource()
        : failingSource(state.kind === "error" ? state.message : ""),
  [state]);
  useEffect(() => { if (state.kind === "feed" && state.act) void act(state.act); }, [state]);
  return (
    <div className="h-dvh">
      <AppShell
        screen={screen}
        platform="web"
        pendingMeetings={0}
        chat={<p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">Chat is not part of the feed rig.</p>}
        capture={null}
        connectors={null}
        settings={null}
        feed={<FeedViewEntries realEntries={[]} source={source} />}
        apps={<AppsPage />}
      />
    </div>
  );
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
function chooseOption(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
/** Rig-only: the first render's follow-up step for states that need a view or filter. */
async function act(step: "done" | "filter-empty") {
  const pressed = () => document.querySelector('[role="group"][aria-label="Show"] button[aria-pressed="true"]');
  for (let tries = 0; !pressed() && tries < 120; tries++) await nextFrame();
  const segment = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Show"] button')].find((node) => node.textContent?.startsWith(label));
  if (step === "done") { segment("Done")?.click(); return; }
  segment("All")?.click();
  document.querySelector<HTMLButtonElement>('button[aria-label="Filter by agent or project"]')?.click();
  await nextFrame(); await nextFrame();
  const agent = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by agent"]');
  const type = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]');
  if (!agent || !type) return;
  chooseOption(agent, agent.options[1]?.value ?? "");
  await nextFrame();
  for (const option of [...type.options].reverse()) {
    chooseOption(type, option.value);
    await nextFrame();
    if (document.body.textContent?.includes("No cards match this filter.")) break;
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

// A phone shows no scrollbar; the bare frame hides them (scrolling still works) so 390 shots match.
const FRAME_CSS = "html, * { scrollbar-width: none; } html::-webkit-scrollbar, *::-webkit-scrollbar { display: none; }";

function Frame() {
  const state = fixture.states[stateId]!;
  if (state.kind === "signed-out") {
    return <div className="h-dvh"><SignedOutSurface homeSite platform="web" state="unauthenticated" error={null} onAction={() => {}} /></div>;
  }
  return <MemoryRouter initialEntries={["/chat/feed"]}><ShellFrame state={state} /></MemoryRouter>;
}

function Picker() {
  const go = (next: { state?: string; w?: string }) => {
    const query = new URLSearchParams({ state: next.state ?? stateId, w: next.w ?? width });
    window.location.search = query.toString();
  };
  const frameWidth = width === "1280" ? 1280 : 390;
  return (
    <div className="min-h-dvh overflow-x-hidden bg-muted/40 p-4 text-foreground">
      <header className="mx-auto mb-4 flex max-w-[1320px] flex-wrap items-center gap-3">
        <h1 className="font-display text-xl font-semibold">Home feed rig</h1>
        <label className="flex items-center gap-2 text-sm">State
          <select aria-label="State" className="min-h-9 rounded-md border border-border bg-background px-2" value={stateId} onChange={(event) => go({ state: event.target.value })}>
            {stateIds.map((id) => <option key={id} value={id}>{fixture.states[id]!.label} ({id})</option>)}
          </select>
        </label>
        <div role="group" aria-label="Width" className="flex gap-1 text-sm">
          {["390", "1280"].map((w) => (
            <button key={w} type="button" aria-pressed={width === w} onClick={() => go({ w })}
              className={`min-h-9 rounded-md border border-border px-3 ${width === w ? "bg-primary text-primary-foreground" : "bg-background"}`}>{w === "390" ? "Phone 390" : "Desktop 1280"}</button>
          ))}
        </div>
        <a className="text-sm underline underline-offset-4" href={`?frame=1&state=${encodeURIComponent(stateId)}`} target="_blank" rel="noreferrer">Open frame alone</a>
        <span className="text-xs text-muted-foreground">Real Home components · data from feed-fixture.json · answers stay in this tab</span>
      </header>
      {/* The frame is the chosen width, or the window's width less the page padding when that is narrower. */}
      <div className="mx-auto" style={{ maxWidth: frameWidth + 2 }}>
        <iframe title={`Home feed: ${fixture.states[stateId]!.label}`} src={`?frame=1&state=${encodeURIComponent(stateId)}`}
          className="block w-full rounded-xl border border-border bg-background shadow-sm" style={{ height: width === "1280" ? 800 : 844 }} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{params.get("frame") === "1" ? <><style>{FRAME_CSS}</style><Frame /></> : <Picker />}</StrictMode>,
);
