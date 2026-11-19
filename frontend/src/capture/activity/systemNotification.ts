/**
 * A system notification (the Mac app's, or the browser's Notification API) while Exo is in the background and the
 * user has allowed notifications. Clicking it brings Exo forward, then runs `onClick`. Returns whether one was shown.
 */
export function showSystemNotification(title: string, options: NotificationOptions, onClick?: (notification: Notification) => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.hasFocus()) return false;
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      onClick?.(notification);
      notification.close();
    };
    return true;
  } catch { return false; }
}
