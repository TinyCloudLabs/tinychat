// The "Record this call" tile: a small floating panel the desktop app shows when a call starts (window
// `call-prompt`, frontend/call-prompt.html). Its own entry, in plain TypeScript: it must not load the app's entry
// chunk. The native side owns every decision (when to offer, when to hide); the tile shows the phase it is sent and
// passes on the two clicks.

export type CallPromptPhase = "hidden" | "offered" | "starting" | "recording";

/** What the tile needs from Tauri: `invoke` from @tauri-apps/api/core and `listen` from @tauri-apps/api/event. */
export interface CallPromptBridge {
  invoke(command: string): Promise<unknown>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;
}

/** The event that carries each new phase, native to tile. */
export const CALL_PROMPT_EVENT = "exo://call-prompt";

const PHASES: readonly CallPromptPhase[] = ["hidden", "offered", "starting", "recording"];

/** `{ phase }` as the phase it names; anything else (an unknown phase, a malformed answer) is "hidden". */
export function readCallPromptPhase(answer: unknown): CallPromptPhase {
  if (answer === null || typeof answer !== "object") return "hidden";
  const { phase } = answer as { phase?: unknown };
  return PHASES.find((known) => known === phase) ?? "hidden";
}

const MARK_SRC = "/icons/pwa-192.png";

/**
 * How long a newly offered tile ignores clicks. The tile appears unannounced over the call and takes the first
 * click, so a click aimed at the call must not land on Start.
 */
export const CALL_PROMPT_CLICK_GUARD_MS = 500;

export interface CallPromptTileOptions {
  /** Milliseconds, for the click guard: tests pass their own clock. */
  now?: () => number;
}

export interface CallPromptTile {
  /** Stops listening. */
  dispose(): void;
}

/** Renders the tile into `root` and keeps it in step with the native side. */
export function mountCallPromptTile(
  root: HTMLElement,
  bridge: CallPromptBridge,
  { now = () => Date.now() }: CallPromptTileOptions = {},
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

  let phase: CallPromptPhase = "hidden";
  // A click whose command has not answered yet: both buttons stay disabled until the native side sends a phase,
  // or the command fails.
  let pending = false;
  // A phase from the event is newer than any answer to the first `call_prompt_state`.
  let heard = false;
  // When the phase last became "offered": clicks before the guard has passed are ignored.
  let offeredAt = -Infinity;
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const render = () => {
    tile.dataset.phase = phase;
    if (phase === "hidden") {
      root.replaceChildren();
      return;
    }
    if (phase === "recording") actions.replaceWith(dot);
    else dot.replaceWith(actions);
    const disabled = pending || phase !== "offered";
    start.disabled = disabled;
    dismiss.disabled = disabled;
    if (tile.parentNode !== root) root.replaceChildren(tile);
  };

  const show = (next: CallPromptPhase) => {
    if (next === "offered" && phase !== "offered") offeredAt = now();
    phase = next;
    pending = false;
    render();
  };

  const click = (command: "call_prompt_start" | "call_prompt_dismiss") => {
    if (pending || phase !== "offered" || now() - offeredAt < CALL_PROMPT_CLICK_GUARD_MS) return;
    pending = true;
    render();
    bridge.invoke(command).catch((error: unknown) => {
      console.error(`[CallPrompt] ${command} failed`, error);
      if (disposed || !pending) return;
      pending = false;
      render();
    });
  };
  start.addEventListener("click", () => click("call_prompt_start"));
  dismiss.addEventListener("click", () => click("call_prompt_dismiss"));

  render();
  // Listen first, then ask: a phase sent between the answer and the listener would otherwise be lost.
  const listening = bridge.listen(CALL_PROMPT_EVENT, (event) => {
    if (disposed) return;
    heard = true;
    show(readCallPromptPhase(event.payload));
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
        if (!disposed && !heard) show(readCallPromptPhase(answer));
      },
      (error: unknown) => console.error("[CallPrompt] call_prompt_state failed", error),
    );
  });

  return {
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = null;
    },
  };
}
