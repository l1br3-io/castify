// OfflineBanner — top-of-page banner shown when `navigator.onLine` is false.
//
// The audit (design-pass §6) flagged the absence of any network-status
// feedback: silent CSRF refresh, silent stream URL refresh, etc. This banner
// makes the most common case (the user's connection dropped) visible. It
// auto-hides when connectivity returns.
//
// Rendered once at the app shell so it appears on every page. The banner is
// dismissible for the current offline period — if the user dismisses it and
// connection drops again later, it re-appears.

import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setDismissed(false);
    };
    const handleOffline = () => {
      setOnline(false);
      setDismissed(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (online || dismissed) return null;

  return (
    <div
      role="status"
      className="bg-[var(--color-castify-accent-dim)] text-[var(--color-castify-canvas)]"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2 text-sm">
        <span>
          You're offline — some things won't load until you reconnect.
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 opacity-80 transition hover:opacity-100"
        >
          ×
        </button>
      </div>
    </div>
  );
}
