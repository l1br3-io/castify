// ShortLinkButton — "Copy short link" sibling of CopyLinkButton
// (short-links, task 003).
//
// Why a sibling and not a CopyButton variant: CopyButton's contract is a
// static `value`; a short link must be resolved asynchronously (per-device
// IndexedDB cache → mint via `api/shorten`) before anything can hit the
// clipboard. This component reuses Button, copyToClipboard, and the
// CopyButton feedback contract (2s label flip + sr-only role=status) but
// owns the resolution state machine.
//
// Failure is never a dead end: any shortener error (network, non-200, 429,
// timeout, bad shape) copies the canonical absolute link instead and
// announces "shortener unavailable" via aria-live. The canonical link stays
// the source of truth; a lost cache entry just re-mints on the next click.

import { useEffect, useRef, useState } from "react";

import { shortenShareUrl } from "../api/shorten";
import { getShortLink, saveShortLink } from "../lib/share-links-db";
import { copyToClipboard } from "../lib/clipboard";
import { absoluteShareUrl } from "../hooks/use-shares";
import { Button } from "./ui/button";
import type { ButtonVariant } from "./ui/button-classes";

const COPIED_RESET_MS = 2000;

type ShortLinkButtonProps = {
  shareId: string;
  /** Relative canonical path (`/share/{token}`); absolutized for minting
   * and fallback copy. */
  linkPath: string;
  /** Fires with the resolved (minted or cached) https short URL — the
   * share dialog displays it. Not fired on the fallback path. */
  onResolved?: (shortUrl: string) => void;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
};

type Phase = "idle" | "minting" | "copied" | "fallback" | "failed";

export function ShortLinkButton({
  shareId,
  linkPath,
  onResolved,
  variant = "secondary",
  size = "sm",
  className,
}: ShortLinkButtonProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  async function handleCopy(): Promise<void> {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setPhase("minting");

    const canonicalUrl = absoluteShareUrl(linkPath);
    let shortUrl: string;
    try {
      const cached = await getShortLink(shareId);
      shortUrl = cached ?? (await shortenShareUrl(canonicalUrl));
      if (!cached) {
        await saveShortLink(shareId, shortUrl);
      }
    } catch {
      // Shortener unavailable — the canonical link is the fallback copy.
      const ok = await copyToClipboard(canonicalUrl);
      setPhase(ok ? "fallback" : "failed");
      resetTimer.current = setTimeout(() => setPhase("idle"), COPIED_RESET_MS);
      return;
    }

    onResolved?.(shortUrl);
    const ok = await copyToClipboard(shortUrl);
    setPhase(ok ? "copied" : "failed");
    resetTimer.current = setTimeout(() => setPhase("idle"), COPIED_RESET_MS);
  }

  const busy = phase === "minting";
  const label =
    phase === "copied" || phase === "fallback" ? "Copied" : busy ? "Shortening…" : "Copy short link";

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        pending={busy}
        onClick={() => void handleCopy()}
      >
        {label}
      </Button>
      {(phase === "fallback" || phase === "failed") && (
        <p className="text-xs text-[var(--color-danger)]" aria-live="polite">
          {phase === "fallback"
            ? "Shortener unavailable — copied the full link instead."
            : "Couldn't copy — please try again."}
        </p>
      )}
      <span role="status" className="sr-only">
        {phase === "copied"
          ? "Copied short link to clipboard"
          : phase === "fallback"
            ? "Copied full link to clipboard"
            : ""}
      </span>
    </>
  );
}
