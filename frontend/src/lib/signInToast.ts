// The TinyCloud SDK shows "Successfully signed in" after sign-in and keeps every
// toast for 7 s; its UI config has no duration option. The app closes that one
// toast after 4 s with the toast's own close button (the SDK host's shadow root
// is open). A toast the owner is pointing at stays, as the SDK's hover pause
// intends.
const SIGNED_IN_TEXT = "Successfully signed in";
export const SIGNED_IN_TOAST_MS = 4_000;

/** Closes the SDK's "Successfully signed in" toast after `ms`. Returns a cancel function. */
export function closeSignedInToastAfter(ms = SIGNED_IN_TOAST_MS): () => void {
  const timer = window.setTimeout(() => {
    for (const host of document.querySelectorAll("[data-tinycloud-ui]")) {
      for (const toast of host.shadowRoot?.querySelectorAll(".toast") ?? []) {
        if (toast.querySelector(".toast__message")?.textContent !== SIGNED_IN_TEXT || toast.matches(":hover")) continue;
        toast.querySelector<HTMLButtonElement>(".toast__close")?.click();
      }
    }
  }, ms);
  return () => window.clearTimeout(timer);
}
