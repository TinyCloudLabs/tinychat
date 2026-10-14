import { getCurrentWindow } from "@tauri-apps/api/window";

export const FINISHING_QUIT_COPY = "Exo is finishing a recording. Quit anyway? It finishes next time you open Exo.";

/** One decision per close request. The native stop journal survives either choice. */
export function askToQuitDuringFinishing(doc: Document = document): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = doc.createElement("dialog");
    dialog.setAttribute("aria-label", "Finish recording before quitting");
    dialog.style.cssText = "max-width:26rem;padding:1.5rem;border:1px solid #888;border-radius:1rem;background:Canvas;color:CanvasText;box-shadow:0 1rem 3rem #0005";
    const message = doc.createElement("p");
    message.textContent = FINISHING_QUIT_COPY;
    const actions = doc.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:.75rem;margin-top:1.5rem";
    const quit = doc.createElement("button");
    quit.textContent = "Quit";
    const wait = doc.createElement("button");
    wait.textContent = "Wait";
    actions.append(quit, wait);
    dialog.append(message, actions);
    doc.body.append(dialog);
    const finish = (choice: boolean) => { dialog.close(); dialog.remove(); resolve(choice); };
    quit.addEventListener("click", () => finish(true), { once: true });
    wait.addEventListener("click", () => finish(false), { once: true });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); }, { once: true });
    dialog.showModal();
    wait.focus();
  });
}

interface CloseWindow {
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

export async function installFinishingQuitGuard(isFinishing: () => Promise<boolean>,
  appWindow: CloseWindow = getCurrentWindow(), ask = askToQuitDuringFinishing,
  subscribeExit?: (handler: () => void) => Promise<() => void>,
  quitApp: () => Promise<void> = () => appWindow.destroy()): Promise<() => void> {
  let prompting = false;
  const decide = async () => {
    if (prompting) return;
    prompting = true;
    try {
      if (!await isFinishing() || await ask()) await quitApp();
    } finally { prompting = false; }
  };
  const unlistenClose = await appWindow.onCloseRequested((event) => {
    // Tauri's close request must be cancelled synchronously. An asynchronous
    // state read otherwise lets the window disappear before the prompt opens.
    event.preventDefault();
    return decide();
  });
  const unlistenExit = await subscribeExit?.(() => { void decide(); });
  return () => { unlistenClose(); unlistenExit?.(); };
}
