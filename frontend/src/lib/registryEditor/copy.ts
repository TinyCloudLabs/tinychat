// TC-3892: approved copy for TinyCloud One -> Settings -> Where your data lives
// (source: /var/tmp/tc3284/tc3890-wording-monica.md, 2026-11-22).

export const REGISTRY_EDITOR_COPY = {
  heading: "Where your data lives",
  intro: "Your apps save and read your data on these hosts.",
  labels: {
    space: "Space",
    host: "Host",
  },
  encryptionLabel: "Secrets and keys",
  notSet: "Not set",
  loading: "Loading…",
  hostsLabel: "Hosts",
  versionLabel: (sequence: number) => `Version ${sequence}`,
  readOnlyNote: "You can see this here, but not change it.",
  updatedLabel: (date: string, origin: string) => `Last changed ${date} by ${origin}`,
  noRecord: "No location is set for your account.",
  changeButton: "Change",
  saveButton: "Continue in OpenKey",
  cancelButton: "Cancel",
  historyHeading: "Recent changes",
  historyRow: (date: string, origin: string, count: number) =>
    `${date} · ${origin} · ${count} ${count === 1 ? "change" : "changes"}`,
  undoButton: "Undo",
  undoConfirmTitle: "Undo this change?",
  undoConfirmBody: (date: string) =>
    `Your apps go back to the hosts you had before ${date}. Data saved at the new hosts in the meantime stays there.`,
  undoConfirmApprove: "Undo with passkey",
  undoConfirmCancel: "Cancel",
  undoSuccess: "Undone. Your apps use your previous hosts from their next sign-in.",
  restoreButton: "Restore the version before this",
  restoreConfirmTitle: (date: string) => `Restore the version from before ${date}?`,
  restoreConfirmBody:
    "Your apps go back to the hosts you had before this change, which also undoes every change after it. Data saved at those hosts in the meantime stays there.",
  restoreConfirmApprove: "Continue in OpenKey",
  restoreConfirmCancel: "Cancel",
  changeSuccess: "Done. Your apps use the new hosts from their next sign-in.",
  changeFailure: "Couldn't change this. Nothing was changed. Try again.",
  registryUnreachable: "Couldn't load where your data lives. Try again in a moment.",
  historyUnavailable: "Couldn't load recent changes. Try again.",
  invalidNodeUrl: "Enter a host that starts with https:// (or http:// for localhost).",
  retryButton: "Try again",
} as const;
