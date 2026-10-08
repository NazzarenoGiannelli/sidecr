import { notificationTitle, shouldNotify, type NotifyKind } from "./notify";

/** The browser's notification permission, or "unsupported" when the API is missing or throws. */
export function notificationPermission(): string {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

/** Notifies if the change calls for it. herdr already plays a sound, so the notification is silent. */
export function notifyIfNeeded(prev: string | null, next: string, paneTitle: string, paneId: string, notifyOnFinish = true): void {
  const kind: NotifyKind | null = shouldNotify(prev, next, document.hasFocus(), notificationPermission(), notifyOnFinish);
  if (!kind) return;
  try {
    const n = new Notification(notificationTitle(kind), { body: paneTitle, tag: paneId, silent: true });
    n.onclick = () => window.focus();
  } catch {
    /* the API may be missing or refuse: a missed notification is not worth an error */
  }
}

/** Asks for permission once, on the first click or touch inside the window, when the browser has not been asked yet. */
export function askPermissionOnFirstPointerDown(): void {
  window.addEventListener(
    "pointerdown",
    () => {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
      } catch {
        /* older browsers throw on the promise form: ignore */
      }
    },
    { once: true },
  );
}
