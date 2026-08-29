// CopyLinkButton — copy a relative share path as an absolute URL, with
// brief copied/failed feedback.
//
// Extracted from `shares-list.tsx` (task 011) so the share-creation dialog
// (task 012) reuses the exact same copy behavior: `navigator.clipboard`
// first, the legacy `execCommand("copy")` dance as fallback, and a 2s
// "Copied" confirmation on the button itself.

import { useEffect, useRef, useState } from "react";

import { copyToClipboard } from "../lib/clipboard";
import { absoluteShareUrl } from "../hooks/use-shares";

const COPIED_RESET_MS = 2000;

/** `linkPath` is relative (`/share/{token}`); the absolute URL is what
 * lands on the clipboard. */
export function CopyLinkButton({ linkPath }: { linkPath: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function handleCopy(): Promise<void> {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    const ok = await copyToClipboard(absoluteShareUrl(linkPath));
    setCopyState(ok ? "copied" : "failed");
    resetTimer.current = setTimeout(
      () => setCopyState("idle"),
      COPIED_RESET_MS,
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="rounded-[var(--radius-button)] border border-[var(--color-castify-rule)] px-3 py-1.5 text-xs transition hover:bg-[var(--color-castify-accent-subtle)]"
      >
        {copyState === "copied" ? "Copied" : "Copy link"}
      </button>
      {copyState === "failed" && (
        <p className="text-xs text-[var(--color-castify-accent-dim)]">
          Couldn't copy — please try again.
        </p>
      )}
    </>
  );
}
