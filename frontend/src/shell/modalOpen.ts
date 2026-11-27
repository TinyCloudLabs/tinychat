// Is something already modal? The one-time registry prompt (FinishSetupNotice.tsx) waits for "no".

/** The App's own dialogs, from the state they read: the storage-full, pending-voice-note sign-out, pricing and rates dialogs. */
export function appDialogOpen(open: { storageFull: boolean; pendingVoiceNoteSignOut: boolean; pricing: boolean; rates: boolean }): boolean {
  return open.storageFull || open.pendingVoiceNoteSignOut || open.pricing || open.rates;
}

/**
 * Any other open modal in the page. Every dialog, alert dialog and sheet here (Radix, the vaul bottom sheet, the few
 * hand-built confirmations) renders an element with role "dialog" or "alertdialog" while it is open, whichever screen
 * owns it, so the page itself is the shared signal. A Radix dialog that is closing keeps `data-state="closed"` until it
 * unmounts and does not count. The finish-setup notice itself is not "another" modal.
 */
export function anotherModalOpen(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')) {
    if (el.getAttribute("data-state") === "closed") continue;
    if (el.closest('[data-testid="finish-setup-notice"]') || el.querySelector('[data-testid="finish-setup-notice"]')) continue;
    return true;
  }
  return false;
}
