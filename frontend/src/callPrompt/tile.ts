// The "Record this call" tile: a small floating panel the desktop app shows when a call starts (window
// `call-prompt`, frontend/call-prompt.html). Its own entry, in plain TypeScript: it must not load the app's entry
// chunk. The native side owns every decision (when to offer, when to hide); the tile shows the state it is sent and
// passes on the clicks. While the recording it started runs, it is a compact bar: a red dot, the time and Stop.

export type CallPromptPhase = "hidden" | "offered" | "starting" | "recording";

/** What the tile needs from Tauri: `invoke` from @tauri-apps/api/core and `listen` from @tauri-apps/api/event. */
export interface CallPromptBridge {
  invoke(command: string): Promise<unknown>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
}

/** The event that carries each new phase, native to tile. */
export const CALL_PROMPT_EVENT = "exo://call-prompt";

const PHASES: readonly CallPromptPhase[] = ["hidden", "offered", "starting", "recording"];

/** The state the native side sends: `elapsedMs` and `paused` only in "recording", and only from a native side new
 * enough to keep the tile during the recording. */
export interface CallPromptState {
  phase: CallPromptPhase;
  /** The recorder's own clock; it does not advance while paused. Absent: show the dot only. */
  elapsedMs?: number;
  paused: boolean;
}

/** `{ phase }` as the phase it names; anything else (an unknown phase, a malformed answer) is "hidden". */
export function readCallPromptPhase(answer: unknown): CallPromptPhase {
  if (answer === null || typeof answer !== "object") return "hidden";
  const { phase } = answer as { phase?: unknown };
  return PHASES.find((known) => known === phase) ?? "hidden";
}

/** The whole state; an `elapsedMs` that is not a finite, non-negative number counts as absent. */
export function readCallPromptState(answer: unknown): CallPromptState {
  const phase = readCallPromptPhase(answer);
  if (phase !== "recording") return { phase, paused: false };
  const { elapsedMs, paused } = answer as { elapsedMs?: unknown; paused?: unknown };
  const valid = typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0;
  return { phase, paused: paused === true, ...(valid ? { elapsedMs } : {}) };
}

/** Elapsed time as `m:ss`, or `h:mm:ss` from one hour. */
export function formatCallPromptElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * How far the shown time may run ahead of the last native value. Native sends the recording state at least once a
 * second, so the tile never drifts from it by more than this.
 */
export const CALL_PROMPT_LOCAL_ADVANCE_MS = 1000;
/** How often the shown time is brought up to date between native states. */
const TICK_MS = 250;

const MARK_SRC = "/icons/pwa-192.png";

/**
 * How long a newly offered tile ignores clicks. The tile appears unannounced over the call and takes the first
 * click, so a click aimed at the call must not land on Start.
 */
export const CALL_PROMPT_CLICK_GUARD_MS = 500;

export interface CallPromptTileOptions {
  /** Milliseconds, for the click guard and the shown time: tests pass their own clock. */
  now?: () => number;
  /** Calls `tick` every `ms` until the returned function is called: tests pass their own. */
  every?: (tick: () => void, ms: number) => () => void;
}

const everyInterval = (tick: () => void, ms: number) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export interface CallPromptTile {
  /** Stops listening. */
  dispose(): void;
}

/** Renders the tile into `root` and keeps it in step with the native side. */
export function mountCallPromptTile(
  root: HTMLElement,
  bridge: CallPromptBridge,
  { now = () => Date.now(), every = everyInterval }: CallPromptTileOptions = {},
): CallPromptTile {
  const doc = root.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };

  const tile = element("div", "cp-tile");
  const mark = element("img", "cp-mark");
  mark.src = MARK_SRC;
  mark.alt = "";
  mark.draggable = false;
  const label = element("p", "cp-label");
  label.textContent = "Record this call";
  const actions = element("div", "cp-actions");
  const start = element("button", "cp-button cp-start");
  start.type = "button";
  start.textContent = "Start";
  const dismiss = element("button", "cp-button cp-dismiss");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  actions.append(start, dismiss);
  const dot = element("span", "cp-dot");
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", "Recording");
  tile.append(mark, label, actions);

  // The recording bar. The time is a timer, not a live region: it is not announced every second.
  const bar = element("div", "cp-bar");
  const barDot = element("span", "cp-rec");
  barDot.setAttribute("role", "img");
  const time = element("span", "cp-time");
  time.setAttribute("role", "timer");
  const stop = element("button", "cp-button cp-stop");
  stop.type = "button";
  stop.textContent = "Stop";
  bar.append(barDot, time, stop);

  let phase: CallPromptPhase = "hidden";
  // The last recording state with a time, and when it arrived (on `now`'s clock).
  let elapsed: { ms: number; at: number; paused: boolean } | null = null;
  let stopTicking: (() => void) | null = null;
  // A click whose command has not answered yet: both buttons stay disabled until the native side sends a phase,
  // or the command fails.
  let pending = false;
  // A phase from the event is newer than any answer to the first `call_prompt_state`.
  let heard = false;
  // When the phase last became "offered": clicks before the guard has passed are ignored.
  let offeredAt = -Infinity;
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const shownMs = () =>
    elapsed!.paused ? elapsed!.ms : elapsed!.ms + Math.min(Math.max(0, now() - elapsed!.at), CALL_PROMPT_LOCAL_ADVANCE_MS);
  const renderTime = () => {
    const text = formatCallPromptElapsed(shownMs());
    if (time.textContent !== text) time.textContent = text;
  };

  const render = () => {
    tile.dataset.phase = phase;
    const ticking = phase === "recording" && elapsed !== null && !elapsed.paused;
    if (!ticking) {
      stopTicking?.();
      stopTicking = null;
    }
    if (phase === "hidden") {
      root.replaceChildren();
      return;
    }
    if (phase === "recording" && elapsed) {
      bar.dataset.paused = String(elapsed.paused);
      barDot.setAttribute("aria-label", elapsed.paused ? "Paused" : "Recording");
      renderTime();
      stop.disabled = pending;
      if (ticking && !stopTicking) stopTicking = every(renderTime, TICK_MS);
      if (bar.parentNode !== root) root.replaceChildren(bar);
      return;
    }
    if (phase === "recording") actions.replaceWith(dot);
    else dot.replaceWith(actions);
    const disabled = pending || phase !== "offered";
    start.disabled = disabled;
    dismiss.disabled = disabled;
    if (tile.parentNode !== root) root.replaceChildren(tile);
  };

  const show = (state: CallPromptState) => {
    if (state.phase === "offered" && phase !== "offered") offeredAt = now();
    phase = state.phase;
    elapsed = state.elapsedMs === undefined ? null : { ms: state.elapsedMs, at: now(), paused: state.paused };
    pending = false;
    render();
  };

  const send = (command: "call_prompt_start" | "call_prompt_dismiss" | "call_prompt_stop") => {
    pending = true;
    render();
    bridge.invoke(command).catch((error: unknown) => {
      console.error(`[CallPrompt] ${command} failed`, error);
      if (disposed || !pending) return;
      pending = false;
      render();
    });
  };
  const click = (command: "call_prompt_start" | "call_prompt_dismiss") => {
    if (pending || phase !== "offered" || now() - offeredAt < CALL_PROMPT_CLICK_GUARD_MS) return;
    send(command);
  };
  start.addEventListener("click", () => click("call_prompt_start"));
  dismiss.addEventListener("click", () => click("call_prompt_dismiss"));
  // Stop needs no guard: the bar is there because the user pressed Start.
  stop.addEventListener("click", () => {
    if (pending || phase !== "recording" || !elapsed) return;
    send("call_prompt_stop");
  });

  render();
  // Listen first, then ask: a phase sent between the answer and the listener would otherwise be lost.
  const listening = bridge.listen(CALL_PROMPT_EVENT, (event) => {
    if (disposed) return;
    heard = true;
    show(readCallPromptState(event.payload));
  }).then(
    (stop) => {
      if (disposed) stop();
      else unlisten = stop;
    },
    (error: unknown) => console.error("[CallPrompt] Could not listen for the tile's state", error),
  );
  void listening.then(() => {
    if (disposed) return;
    bridge.invoke("call_prompt_state").then(
      (answer) => {
        if (!disposed && !heard) show(readCallPromptState(answer));
      },
      (error: unknown) => console.error("[CallPrompt] call_prompt_state failed", error),
    );
  });

  return {
    dispose() {
      disposed = true;
      stopTicking?.();
      stopTicking = null;
      unlisten?.();
      unlisten = null;
    },
  };
}
