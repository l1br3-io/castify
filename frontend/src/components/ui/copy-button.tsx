// CopyButton — copy text to the clipboard with "Copied" feedback
// (see ui/README.md § CopyButton). Extraction of the pattern that lived in
// copy-link-button.tsx; that component is now a thin wrapper giving it a
// share path instead of raw text.
//
// Feedback contract: success flips the label to `copiedLabel` for 2s and a
// visually-hidden role=status region announces it (label flips alone are
// not reliably announced); failure shows an inline aria-live message and
// keeps the label. Both reset to idle after 2s.

import { useEffect, useRef, useState } from "react";

import { copyToClipboard } from "../../lib/clipboard";
import { Button } from "./button";
import type { ButtonVariant } from "./button-classes";

const COPIED_RESET_MS = 2000;

type CopyButtonProps = {
  /** Text placed on the clipboard. */
  value: string;
  label?: string;
  copiedLabel?: string;
  failMessage?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
};

export function CopyButton({
  value,
  label = "Copy link",
  copiedLabel = "Copied",
  failMessage = "Couldn't copy — please try again.",
  variant = "secondary",
  size = "sm",
  className,
}: CopyButtonProps) {
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
    const ok = await copyToClipboard(value);
    setCopyState(ok ? "copied" : "failed");
    resetTimer.current = setTimeout(() => setCopyState("idle"), COPIED_RESET_MS);
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => void handleCopy()}
      >
        {copyState === "copied" ? copiedLabel : label}
      </Button>
      {copyState === "failed" && (
        <p className="text-xs text-[var(--color-danger)]" aria-live="polite">
          {failMessage}
        </p>
      )}
      <span role="status" className="sr-only">
        {copyState === "copied" ? `${copiedLabel} to clipboard` : ""}
      </span>
    </>
  );
}
