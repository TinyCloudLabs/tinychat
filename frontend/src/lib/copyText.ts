/**
 * Copy `text` to the clipboard, returning whether it landed.
 *
 * The textarea + execCommand path is not legacy-browser padding: browser
 * clipboard writes reject when the document is not focused, which happens
 * routinely right after a dialog closes or the window loses focus, so the
 * async API alone silently loses copies.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the textarea path below. Browser clipboard writes can fail
    // when the document is not focused.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
