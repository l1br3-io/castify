// ErrorState — shared error surface with optional retry.
//
// Replaces the bespoke `<p className="text-red-400">Couldn't load X.</p>`
// pattern. Uses the accent (not red) so errors read as actionable rather
// than alarming — consistent with the rest of the design language. The
// retry CTA is the primary affordance; if `onRetry` is omitted, the
// surface becomes informational only (caller should provide guidance in
// the body about what to do next).

import { Button } from "./button";

type ErrorStateProps = {
  title?: string;
  body?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Compact variant for inline use (shelves, small panels). */
  compact?: boolean;
};

export function ErrorState({
  title = "Couldn't load this.",
  body,
  onRetry,
  retryLabel = "Try again",
  compact = false,
}: ErrorStateProps) {
  const padding = compact ? "p-6" : "p-8 sm:p-12";
  const titleSize = compact ? "text-base" : "text-lg";
  const bodySize = compact ? "text-xs" : "text-sm";

  return (
    <div
      role="alert"
      className={`rounded-[var(--radius-card)] border border-[var(--color-castify-rule)] bg-[var(--color-castify-surface)] ${padding} text-center`}
    >
      <p className={`font-medium ${titleSize}`}>{title}</p>
      {body && (
        <p className={`mx-auto mt-2 max-w-sm opacity-70 ${bodySize}`}>{body}</p>
      )}
      {onRetry && (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
