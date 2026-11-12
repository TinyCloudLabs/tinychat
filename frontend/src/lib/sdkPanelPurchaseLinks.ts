// App Store 3.1.1 and Google Play Payments, for the TinyCloud SDK's own UI (@tinycloud/web-sdk 3.11.2): its panel's Storage
// section and its storage-full toast link to account.tinycloud.xyz, where a plan can be bought, and its storage-full
// sentence says "or upgrade". The SDK has no option to leave these out yet (a `ui` flag is requested from the SDK team).
// Until it does, the iOS and Android apps hide those links and reword that sentence inside the SDK's host, which is an
// open shadow root on a child of <body> (the panel, the toasts and the floating button all render there).
import { NATIVE_PLAN_NOTE } from "@/lib/storageStatus";

/** The SDK's `storage.full` string, and what the phone apps show instead. */
export const SDK_STORAGE_FULL_TEXT = "Storage is full. Free up space or upgrade to keep saving.";
export const PHONE_STORAGE_FULL_TEXT = `Storage is full. Free up space to keep saving. ${NATIVE_PLAN_NOTE}`;

/** The panel's Storage section link (`storage.manage`, wrapped in `.storage-link`) and any link to the account app. */
const PURCHASE_LINKS = '.storage-link, a.storage-manage, a[href^="https://account.tinycloud.xyz"]';
const STYLE_ID = "tinycloud-home-no-purchase-links";

function reword(root: ShadowRoot): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue?.trim() === SDK_STORAGE_FULL_TEXT) node.nodeValue = PHONE_STORAGE_FULL_TEXT;
  }
  // The storage-full toast carries its link with whatever https address the node reported, so it is found by its message.
  for (const toast of root.querySelectorAll(".toast")) {
    if (!toast.textContent?.includes(PHONE_STORAGE_FULL_TEXT)) continue;
    for (const link of toast.querySelectorAll("a")) link.hidden = true;
  }
}

function patch(root: ShadowRoot): MutationObserver {
  if (root.getElementById(STYLE_ID) === null) {
    const style = root.ownerDocument.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `${PURCHASE_LINKS}, .toast a[hidden] { display: none !important; }`;
    root.append(style);
  }
  reword(root);
  const observer = new MutationObserver(() => reword(root));
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return observer;
}

/**
 * Hides the SDK UI's purchase links and rewords its storage-full sentence, now and whenever the SDK renders or re-renders,
 * for as long as the returned stop function is not called. Only the iOS and Android apps call this.
 */
export function hideSdkPurchaseLinks(doc: Document = document): () => void {
  const patched = new Map<ShadowRoot, MutationObserver>();
  const scan = () => {
    // The SDK removes its host when its last client unregisters and makes a new one later.
    for (const [root, observer] of patched) {
      if (!root.host.isConnected) {
        observer.disconnect();
        patched.delete(root);
      }
    }
    for (const host of doc.body.children) {
      const root = host.shadowRoot;
      if (root !== null && !patched.has(root)) patched.set(root, patch(root));
    }
  };
  scan();
  const hosts = new MutationObserver(scan);
  hosts.observe(doc.body, { childList: true });
  return () => {
    hosts.disconnect();
    for (const observer of patched.values()) observer.disconnect();
    patched.clear();
  };
}
